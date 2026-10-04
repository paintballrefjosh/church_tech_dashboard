import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  type OnModuleInit,
  type OnModuleDestroy,
} from "@nestjs/common";
import { eq } from "drizzle-orm";
import {
  DNS_MANAGED_MARKER,
  type DnsHealthMonitorsInput,
  type DnsHealthMonitorsResult,
} from "@church/shared";
import { DB, type Db } from "../db/db.module";
import { monitors } from "../db/schema";
import { SettingsService } from "../settings/settings.service";
import { NotificationsService } from "../notifications/notifications.service";
import { InfraService } from "../infra/infra.service";
import { MonitorsService } from "../monitors/monitors.service";
import { DnsService } from "./dns.service";
import { technitiumCall, TechnitiumError, type TechnitiumConfig, type TRecord, type TZone } from "./technitium";

const POLL_MS = 60_000;
// Consecutive failed polls before alerting (~3 minutes), so a primary restart
// or a brief network blip doesn't page anyone.
const FAILS_TO_ALERT = 3;

const CANARY_LABEL = "_dashboard-canary";
const CANARY_TEXT = "ok";
// Contains the managed marker so the Records view treats the canary as
// sync-owned (no hand edits); the sync itself only manages A/PTR records.
const CANARY_COMMENT = `Health canary for the dashboard's DNS monitors (${DNS_MANAGED_MARKER})`;

/**
 * DNS health: (1) an opt-in alert when the Technitium primary's API stops
 * answering, and (2) one-click `dns` uptime monitors per cluster node.
 *
 * The alert is notification-only, like the UniFi device-offline alert: the
 * primary's API isn't a monitor row, so there's no monitor_incident to open.
 * Node-level DNS failures get real incidents through the health monitors,
 * which the monitor worker probes like any other uptime monitor.
 */
@Injectable()
export class DnsHealthService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DnsHealthService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private failures = 0;
  private alerted = false;
  private polling = false;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
    private readonly infra: InfraService,
    private readonly monitorsService: MonitorsService,
    private readonly dns: DnsService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.poll(), POLL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const enabled = (await this.settings.get("dns.alert_unreachable")) === true;
      const summary = enabled ? await this.dns.summary() : null;
      if (!summary?.configured) {
        // Alerting off or nothing to watch: forget state so turning it back
        // on doesn't fire a stale "recovered".
        this.failures = 0;
        this.alerted = false;
        return;
      }
      if (summary.reachable) {
        if (this.alerted) {
          await this.fanOut("DNS primary recovered", `The Technitium primary${summary.server ? ` (${summary.server})` : ""} is answering again.`);
        }
        this.failures = 0;
        this.alerted = false;
        return;
      }
      this.failures++;
      if (this.failures >= FAILS_TO_ALERT && !this.alerted) {
        this.alerted = true;
        await this.fanOut(
          "DNS primary unreachable",
          `The Technitium primary's API has not answered for ${FAILS_TO_ALERT} minutes: ${summary.error ?? "unknown error"}. ` +
            "Lookups continue on the secondary, but record edits and the IPAM sync are stopped until it recovers or a secondary is promoted.",
        );
      }
    } catch (err) {
      this.logger.debug(`dns health poll failed: ${(err as Error).message}`);
    } finally {
      this.polling = false;
    }
  }

  private async fanOut(title: string, body: string): Promise<void> {
    try {
      // Maintenance mode silences the notification; the up/down tracking
      // above continues so the state stays right when it's switched off.
      if ((await this.settings.get("monitoring.maintenance_mode")) === true) return;
      const recipients = await this.infra.monitoringRecipientIds();
      if (!recipients.length) return;
      await this.notifications.createMany(
        recipients.map((id) => ({
          recipientUserId: id,
          kind: "dns.primary_unreachable",
          title,
          body,
          link: "/monitoring/dns",
        })),
      );
    } catch (err) {
      this.logger.warn(`DNS alert fan-out failed: ${(err as Error).message}`);
    }
  }

  /**
   * Ensure the canary TXT record exists, then one `dns` monitor per node IP
   * that resolves it through that node. Idempotent: existing monitors with the
   * same canary + resolver are reported, not duplicated.
   */
  async createHealthMonitors(input: DnsHealthMonitorsInput): Promise<DnsHealthMonitorsResult> {
    const conn = await this.dns.requireConfig();
    const zone = await this.pickZone(conn, input.zone);
    const canary = `${CANARY_LABEL}.${zone}`;
    await this.ensureCanary(conn, zone, canary);

    let nodes: Array<{ ip: string; name: string }>;
    if (input.nodes && input.nodes.length > 0) {
      nodes = input.nodes.map((ip) => ({ ip, name: ip }));
    } else {
      const summary = await this.dns.summary();
      nodes = (summary.nodes ?? [])
        .filter((n) => n.ipAddress)
        .map((n) => ({ ip: n.ipAddress!, name: n.name || n.ipAddress! }));
      if (nodes.length === 0) {
        throw new BadRequestException(
          "No cluster node list (single node, or the token lacks Administration: View). Enter the node IPs.",
        );
      }
    }

    const existingRows = await this.db.select().from(monitors).where(eq(monitors.kind, "dns"));
    const result: DnsHealthMonitorsResult = { id: canary, canary, created: [], existing: [] };
    for (const node of nodes) {
      const match = existingRows.find(
        (m) => m.target === canary && (m.options as { resolver?: string } | null)?.resolver === node.ip,
      );
      if (match) {
        result.existing.push({ monitorId: match.id, name: match.name, resolver: node.ip });
        continue;
      }
      const name = `DNS ${node.name}`;
      const row = await this.monitorsService.create({
        name,
        kind: "dns",
        target: canary,
        intervalSec: 60,
        failThreshold: 2,
        recoverThreshold: 2,
        options: { recordType: "TXT", expectedValue: CANARY_TEXT, resolver: node.ip, timeoutMs: 5_000 },
        enabled: true,
      });
      result.created.push({ monitorId: row.id, name, resolver: node.ip });
    }
    return result;
  }

  /** The requested zone, else dns.sync_zone, else the first primary forward zone. */
  private async pickZone(conn: TechnitiumConfig, requested: string | undefined): Promise<string> {
    const list = await this.call<{ zones?: TZone[] }>(conn, "zones/list");
    const primaries = (list.zones ?? [])
      .filter((z) => !z.internal && z.type === "Primary" && z.name && !z.name.endsWith(".arpa"))
      .map((z) => z.name!.toLowerCase());
    const syncZone = (((await this.settings.get("dns.sync_zone")) as string | undefined) ?? "").trim().toLowerCase();
    const zone = requested || (primaries.includes(syncZone) ? syncZone : primaries[0]);
    if (!zone) throw new BadRequestException("No primary forward zone to hold the health canary. Create one in Technitium first.");
    if (!primaries.includes(zone)) throw new BadRequestException(`${zone} isn't a primary forward zone on the Technitium primary`);
    return zone;
  }

  private async ensureCanary(conn: TechnitiumConfig, zone: string, canary: string): Promise<void> {
    const res = await this.call<{ records?: TRecord[] }>(conn, "zones/records/get", { domain: canary, zone });
    const present = (res.records ?? []).some(
      (r) => r.type === "TXT" && (r.rData as { text?: string } | undefined)?.text === CANARY_TEXT,
    );
    if (present) return;
    try {
      await technitiumCall<unknown>(
        conn,
        "zones/records/add",
        { zone, domain: canary, type: "TXT", ttl: 60, text: CANARY_TEXT, comments: CANARY_COMMENT },
        "POST",
      );
    } catch (err) {
      if (err instanceof TechnitiumError) throw new BadRequestException(`Couldn't create the canary record: ${err.message}`);
      throw err;
    }
  }

  private async call<T>(conn: TechnitiumConfig, path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    try {
      return await technitiumCall<T>(conn, path, params);
    } catch (err) {
      if (err instanceof TechnitiumError) throw new BadRequestException(`Technitium: ${err.message}`);
      throw err;
    }
  }
}
