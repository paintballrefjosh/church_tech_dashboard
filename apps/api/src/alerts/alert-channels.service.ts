import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { asc, eq } from "drizzle-orm";
import {
  ALERT_CHANNEL_SECRET,
  alertChannelConfigSchemas,
  alertDestinationOf,
  alertDestinationProblem,
  buildAlertRequests,
  channelWantsAlert,
  isForbiddenAlertAddress,
  type AlertChannel,
  type AlertChannelEvents,
  type AlertChannelType,
  type AlertEvent,
  type CreateAlertChannelInput,
  type UpdateAlertChannelInput,
} from "@church/shared";
import { dbErrorCode } from "@church/shared/db";
import { DB, type Db } from "../db/db.module";
import { alertChannels } from "../db/schema";
import { SettingsService } from "../settings/settings.service";
import { decryptStoredSecret, encryptSecret } from "../settings/crypto";

type Row = typeof alertChannels.$inferSelect;

/** How long one delivery may take (connect + answer). */
const SEND_TIMEOUT_MS = 10_000;

export function toAlertChannel(r: Row): AlertChannel {
  return {
    id: r.id,
    name: r.name,
    type: r.type as AlertChannelType,
    enabled: r.enabled,
    events: r.events as AlertChannelEvents,
    config: (r.config as Record<string, unknown>) ?? {},
    hasSecret: !!r.secret,
    lastSentAt: r.lastSentAt?.toISOString() ?? null,
    lastError: r.lastError,
    lastErrorAt: r.lastErrorAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/**
 * Alert channels: saved destinations and the sending itself. Writes are made by the monitoring admin tier through the
 * controller (audited); sending happens from the `alert-dispatch` job and the "Send a test" button. Nothing here follows
 * a redirect or posts to a link-local address (cloud metadata), and the secret never leaves this service in clear.
 */
@Injectable()
export class AlertChannelsService {
  private readonly logger = new Logger(AlertChannelsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly settings: SettingsService,
  ) {}

  async list(): Promise<AlertChannel[]> {
    const rows = await this.db.select().from(alertChannels).orderBy(asc(alertChannels.name));
    return rows.map(toAlertChannel);
  }

  private async row(id: string): Promise<Row> {
    const [r] = await this.db.select().from(alertChannels).where(eq(alertChannels.id, id)).limit(1);
    if (!r) throw new NotFoundException("Alert channel not found");
    return r;
  }

  async get(id: string): Promise<AlertChannel> {
    return toAlertChannel(await this.row(id));
  }

  /** The type's settings, checked; and the destination address, when the type has one to check. */
  private checkConfig(type: AlertChannelType, config: unknown, secret: string | null): Record<string, unknown> {
    const parsed = alertChannelConfigSchemas[type].safeParse(config ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const cfg = parsed.data as Record<string, unknown>;
    if (ALERT_CHANNEL_SECRET[type].required && !secret) {
      throw new BadRequestException(`${ALERT_CHANNEL_SECRET[type].label} is required`);
    }
    const dest = alertDestinationOf(type, cfg, secret);
    if (dest !== null) {
      const problem = alertDestinationProblem(type, dest);
      if (problem) throw new BadRequestException(problem);
    }
    return cfg;
  }

  async create(input: CreateAlertChannelInput): Promise<AlertChannel> {
    const secret = input.secret?.trim() || null;
    const config = this.checkConfig(input.type, input.config, secret);
    try {
      const [r] = await this.db
        .insert(alertChannels)
        .values({
          name: input.name,
          type: input.type,
          enabled: input.enabled,
          events: input.events,
          config,
          secret: secret ? encryptSecret(secret) : null,
        })
        .returning();
      return toAlertChannel(r!);
    } catch (err) {
      if (dbErrorCode(err) === "23505") throw new ConflictException("An alert channel with that name already exists");
      throw err;
    }
  }

  async update(id: string, input: UpdateAlertChannelInput): Promise<AlertChannel> {
    const existing = await this.row(id);
    const type = existing.type as AlertChannelType;
    // Secret: left out keeps the saved one, "" removes it.
    let secret: string | null = existing.secret ? decryptStoredSecret(existing.secret, "alert channel secret") : null;
    if (input.secret !== undefined) secret = input.secret.trim() || null;
    const config = this.checkConfig(type, input.config ?? existing.config, secret);
    const patch: Partial<typeof alertChannels.$inferInsert> = { config, updatedAt: new Date() };
    if (input.name !== undefined) patch.name = input.name;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (input.events !== undefined) patch.events = input.events;
    if (input.secret !== undefined) patch.secret = secret ? encryptSecret(secret) : null;
    try {
      const [r] = await this.db.update(alertChannels).set(patch).where(eq(alertChannels.id, id)).returning();
      return toAlertChannel(r!);
    } catch (err) {
      if (dbErrorCode(err) === "23505") throw new ConflictException("An alert channel with that name already exists");
      throw err;
    }
  }

  async remove(id: string): Promise<void> {
    await this.row(id);
    await this.db.delete(alertChannels).where(eq(alertChannels.id, id));
  }

  /** Send a test message to one channel, whether or not it is switched on. Throws with the reason when it fails. */
  async test(id: string): Promise<AlertChannel> {
    const r = await this.row(id);
    const base = await this.settings.publicBaseUrl();
    await this.deliver(r, {
      kind: "alert.test",
      title: "Test alert from the dashboard",
      body: "If you can read this, this channel receives monitoring alerts.",
      url: base ? `${base}/monitoring/alert-channels` : null,
      at: new Date(),
    });
    return toAlertChannel(await this.row(id));
  }

  /** Send one alert to every switched-on channel that wants its kind. Failures are recorded on the channel, never thrown. */
  async sendToChannels(event: AlertEvent): Promise<{ sent: number; failed: number }> {
    const rows = await this.db.select().from(alertChannels).where(eq(alertChannels.enabled, true));
    let sent = 0;
    let failed = 0;
    await Promise.all(
      rows
        .filter((r) => channelWantsAlert(r.events as AlertChannelEvents, event.kind))
        .map(async (r) => {
          try {
            await this.deliver(r, event);
            sent++;
          } catch {
            failed++;
          }
        }),
    );
    return { sent, failed };
  }

  /** Post `event` to channel `r`; records the outcome on the row; throws (BadRequest, with the reason) on failure. */
  private async deliver(r: Row, event: AlertEvent): Promise<void> {
    const siteName = String((await this.settings.get("site.name")) || "Church Dashboard");
    try {
      const secret = r.secret ? decryptStoredSecret(r.secret, "alert channel secret") : null;
      const requests = buildAlertRequests({ type: r.type as AlertChannelType, config: (r.config as Record<string, unknown>) ?? {}, secret }, event, {
        siteName,
        sign: (key, data) => createHmac("sha256", key).update(data).digest("hex"),
        base64: (s) => Buffer.from(s, "utf8").toString("base64"),
      });
      if (requests.length === 0) throw new Error("This channel has nowhere to send to.");
      for (const req of requests) {
        const problem = alertDestinationProblem(r.type as AlertChannelType, req.url);
        if (problem) throw new Error(problem);
        await this.refuseLinkLocal(req.url);
        const res = await fetch(req.url, {
          method: req.method,
          headers: { ...req.headers, "user-agent": "church-dashboard-alerts" },
          body: req.body,
          redirect: "manual",
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
        if (res.status < 200 || res.status >= 300) {
          const text = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
          throw new Error(`The service answered ${res.status}${text ? `: ${text}` : ""}`);
        }
      }
      await this.db.update(alertChannels).set({ lastSentAt: new Date(), lastError: null, lastErrorAt: null }).where(eq(alertChannels.id, r.id));
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const message = /aborted|timeout/i.test(raw) ? `No answer within ${SEND_TIMEOUT_MS / 1000} seconds.` : raw.slice(0, 500);
      this.logger.warn(`alert channel "${r.name}" (${r.type}) failed: ${message}`);
      await this.db
        .update(alertChannels)
        .set({ lastError: message, lastErrorAt: new Date() })
        .where(eq(alertChannels.id, r.id))
        .catch(() => undefined);
      throw new BadRequestException(message);
    }
  }

  /** A host name that resolves to a link-local address is refused like the literal (a DNS name for cloud metadata). */
  private async refuseLinkLocal(url: string): Promise<void> {
    const host = new URL(url).hostname;
    let addrs: { address: string }[] = [];
    try {
      addrs = await lookup(host, { all: true });
    } catch {
      return; // the request itself will fail with a clearer message
    }
    if (addrs.some((a) => isForbiddenAlertAddress(a.address))) {
      throw new Error("That address resolves to a link-local address (where cloud metadata services live) and is not allowed.");
    }
  }
}
