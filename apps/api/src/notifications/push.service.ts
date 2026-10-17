import { createHash } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, inArray } from "drizzle-orm";
import webpush from "web-push";
import { isUrgentNotificationKind, pushPayloadFor, type PushPayload, type PushSubscribeInput } from "@church/shared";
import { DB, type Db } from "../db/db.module";
import { pushSubscriptions } from "../db/schema";
import { SettingsService } from "../settings/settings.service";
import { deriveVapidKeys, type VapidKeys } from "./vapid";

export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushSendOptions {
  subject: string;
  keys: VapidKeys;
  urgent: boolean;
}

/** What delivers one push. The real one is `web-push`; tests give their own. It throws an error with `statusCode` on refusal. */
export type PushSender = (target: PushTarget, payload: string, options: PushSendOptions) => Promise<void>;

const realSender: PushSender = async (target, payload, options) => {
  await webpush.sendNotification({ endpoint: target.endpoint, keys: target.keys }, payload, {
    vapidDetails: { subject: options.subject, publicKey: options.keys.publicKey, privateKey: options.keys.privateKey },
    // A notice that could not be delivered within the hour is stale: let the push service drop it.
    TTL: 3600,
    urgency: options.urgent ? "high" : "normal",
    timeout: 10_000,
  });
};

/**
 * A short fingerprint of a subscription's address. The browser computes the same for its own subscription, so the device
 * list can say "this browser" without the address itself ever being sent back to a page.
 */
export function endpointFingerprint(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex").slice(0, 16);
}

export interface PushSubscriptionView {
  id: string;
  fingerprint: string;
  userAgent: string;
  createdAt: Date;
  lastSentAt: Date | null;
  lastError: string | null;
}

export interface PushOutcome {
  sent: number;
  removed: number;
  failed: number;
}

/**
 * Web Push: which browsers a person turned push on in, and sending to them. The site identifies itself to the browsers' push
 * services with a key pair derived from `AUTH_SECRET` (`deriveVapidKeys`). A push is sent by the node that created the
 * notification (no job, nothing to coordinate); a device the push service says is gone is deleted, anything else is recorded
 * on the row and shown to the person. Pushes never block or fail the action that caused them.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private vapid: VapidKeys | null = null;
  private sender: PushSender = realSender;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly settings: SettingsService,
  ) {}

  /** For tests: replace the thing that talks to the push services. */
  useSender(sender: PushSender): void {
    this.sender = sender;
  }

  private keys(): VapidKeys {
    if (!this.vapid) this.vapid = deriveVapidKeys(process.env.AUTH_SECRET ?? "");
    return this.vapid;
  }

  /** Is push on for the site? On unless an admin switched it off (and it needs a secret to sign with). */
  async enabled(): Promise<boolean> {
    if (!process.env.AUTH_SECRET) return false;
    return (await this.settings.get("notifications.push_enabled").catch(() => true)) !== false;
  }

  publicKey(): string {
    return this.keys().publicKey;
  }

  /** Who the site says it is to the push service: its address when that is https, else the sender address, else a placeholder. */
  private async subject(): Promise<string> {
    const base = await this.settings.publicBaseUrl().catch(() => "");
    if (/^https:\/\//i.test(base)) return base;
    const from = await this.settings.get("smtp.from_email").catch(() => "");
    if (typeof from === "string" && /^[^@\s]+@[^@\s]+$/.test(from.trim())) return `mailto:${from.trim()}`;
    return "mailto:noreply@example.com";
  }

  async list(userId: string): Promise<PushSubscriptionView[]> {
    const rows = await this.db
      .select({
        id: pushSubscriptions.id,
        endpoint: pushSubscriptions.endpoint,
        userAgent: pushSubscriptions.userAgent,
        createdAt: pushSubscriptions.createdAt,
        lastSentAt: pushSubscriptions.lastSentAt,
        lastError: pushSubscriptions.lastError,
      })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId))
      .orderBy(desc(pushSubscriptions.createdAt));
    return rows.map(({ endpoint, ...rest }) => ({ ...rest, fingerprint: endpointFingerprint(endpoint) }));
  }

  /**
   * Save a browser's subscription. The same browser subscribing again (or after someone else signed in on it) updates the one
   * row for its address: an address belongs to one person at a time, and the new owner is whoever just subscribed.
   */
  async subscribe(userId: string, input: PushSubscribeInput, userAgent: string): Promise<{ id: string }> {
    const ua = userAgent.slice(0, 300);
    const [row] = await this.db
      .insert(pushSubscriptions)
      .values({ userId, endpoint: input.endpoint, p256dh: input.keys.p256dh, auth: input.keys.auth, userAgent: ua })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: { userId, p256dh: input.keys.p256dh, auth: input.keys.auth, userAgent: ua, lastError: null },
      })
      .returning({ id: pushSubscriptions.id });
    return { id: row!.id };
  }

  /** Remove one of the caller's own devices. Returns whether there was one. */
  async remove(userId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.userId, userId)))
      .returning({ id: pushSubscriptions.id });
    return rows.length > 0;
  }

  /** Which of these people have at least one device (so the caller knows whether a push can reach them). */
  async usersWithDevices(userIds: string[]): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const rows = await this.db
      .selectDistinct({ userId: pushSubscriptions.userId })
      .from(pushSubscriptions)
      .where(inArray(pushSubscriptions.userId, userIds));
    return new Set(rows.map((r) => r.userId));
  }

  /** Push a payload to every device of every listed person. Never throws. */
  async send(userIds: string[], payload: PushPayload): Promise<PushOutcome> {
    const out: PushOutcome = { sent: 0, removed: 0, failed: 0 };
    try {
      if (userIds.length === 0 || !(await this.enabled())) return out;
      const subs = await this.db.select().from(pushSubscriptions).where(inArray(pushSubscriptions.userId, userIds));
      if (subs.length === 0) return out;
      const options: PushSendOptions = { subject: await this.subject(), keys: this.keys(), urgent: isUrgentNotificationKind(payload.kind) };
      const body = JSON.stringify(payload);
      await Promise.all(
        subs.map(async (s) => {
          try {
            await this.sender({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, options);
            out.sent++;
            await this.db.update(pushSubscriptions).set({ lastSentAt: new Date(), lastError: null }).where(eq(pushSubscriptions.id, s.id));
          } catch (err) {
            const status = (err as { statusCode?: number }).statusCode;
            if (status === 404 || status === 410) {
              // The browser unsubscribed or the push service forgot it: it can never receive again.
              out.removed++;
              await this.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, s.id));
              return;
            }
            out.failed++;
            const message = `${status ? `${status}: ` : ""}${(err as Error).message ?? "send failed"}`.slice(0, 300);
            await this.db.update(pushSubscriptions).set({ lastError: message }).where(eq(pushSubscriptions.id, s.id));
          }
        }),
      );
    } catch (err) {
      this.logger.warn(`push send failed: ${(err as Error).message}`);
    }
    return out;
  }

  /** A push to this person's devices, to prove it works. */
  async sendTest(userId: string): Promise<PushOutcome> {
    return this.send(
      [userId],
      pushPayloadFor({ kind: "system.test", title: "Push notifications are on", body: "This is a test. You will get notices like this on this device.", link: "/me" }),
    );
  }
}
