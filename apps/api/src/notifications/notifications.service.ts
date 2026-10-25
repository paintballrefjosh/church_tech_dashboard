import { Injectable, Inject, NotFoundException, Logger } from "@nestjs/common";
import { and, desc, eq, isNull, count, inArray } from "drizzle-orm";
import {
  DEFAULT_NOTIFICATION_DELIVERY,
  INBOUND_KEYS,
  emailReleaseAt,
  isAlertKind,
  pushAllowed,
  pushPayloadFor,
  ticketSubjectToken,
  type NotificationDelivery,
  type NotificationKind,
} from "@church/shared";
import { DB, type Db } from "../db/db.module";
import { alertOutbox, notificationHeld, notifications, notificationPrefs, users } from "../db/schema";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { MailerService } from "../mailer/mailer.service";
import { SettingsService } from "../settings/settings.service";
import { renderEmail } from "../mailer/templates";
import { NotificationDeliveryService } from "./notification-delivery.service";
import { PushService } from "./push.service";

/**
 * Default channels when a user has no `notification_prefs` row for this kind.
 * Matches the legacy behaviour (in-app + email) so existing users feel no
 * change after the per-kind matrix rolls out.
 */
const DEFAULT_CHANNELS: ReadonlyArray<string> = ["in_app", "email"];

interface ResolvedChannels {
  inApp: boolean;
  email: boolean;
  /** Push is opt-in: a kind with no saved choice never pushes. */
  push: boolean;
}

function resolveChannels(channels: string[] | undefined): ResolvedChannels {
  const list = channels ?? DEFAULT_CHANNELS;
  return { inApp: list.includes("in_app"), email: list.includes("email"), push: list.includes("push") };
}

/** What an email says, whether it goes at once or after being held. */
export interface MailableNotice {
  title: string;
  body?: string | null;
  link?: string | null;
  ticketNumber?: number | null;
}

/**
 * Turn a (usually relative) notification link into an absolute URL for an email
 * CTA, using the resolved public base (site.url). Already-absolute links pass
 * through. When there's no base we return undefined and drop the button rather
 * than ship an unclickable relative href in someone's inbox.
 */
function absoluteEmailLink(base: string, link: string | null | undefined): string | undefined {
  if (!link) return undefined;
  if (/^https?:\/\//i.test(link)) return link;
  if (!base) return undefined;
  return `${base}${link.startsWith("/") ? "" : "/"}${link}`;
}

export interface CreateNotificationInput {
  recipientUserId: string;
  kind: NotificationKind | string;
  title: string;
  body?: string;
  link?: string | null;
  /**
   * If set, MailerService.sendBestEffort() is invoked with a plain-text body
   * built from title + body + the public link. Defaults to true; pass false
   * for high-volume in-app-only events.
   */
  email?: boolean;
  /** Same for a browser push. Defaults to true; the person's own choice for this kind still applies. */
  push?: boolean;
  /** Skip create entirely if recipient === actor. */
  excludeActorId?: string;
  /**
   * The ticket this is about, for notices the person may answer by replying to the email. When the helpdesk mailbox is on,
   * the email's subject carries `[#n]` and its Reply-To is the help address, so the reply comes back as a comment. Leave it
   * off for anything the requester must not see (an internal note): that reply would be a public comment.
   */
  ticketNumber?: number;
  /**
   * A monitoring alert kind (`isAlertKind`) is also queued for the alert channels (team chat, ntfy, SMS ...), once per
   * distinct notice however many people it goes to. False skips that: the `alert-dispatch` job sets it when it tells people
   * about an alert it is already sending to the channels itself.
   */
  alertChannels?: boolean;
}

export interface EmailContext {
  siteName: string;
  base: string;
  replyAddress: string | null;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly realtime: RealtimeGateway,
    private readonly mailer: MailerService,
    private readonly settings: SettingsService,
    private readonly delivery: NotificationDeliveryService,
    private readonly push: PushService,
  ) {}

  /** Best-effort site name lookup for email rendering; falls back to a default. */
  private async siteNameForEmail(): Promise<string> {
    const v = await this.settings.get("site.name");
    return typeof v === "string" && v.length > 0 ? v : "Church Dashboard";
  }

  /**
   * Queue alert kinds for the alert channels: one row per distinct notice (a fan-out to twenty people is one alert). Never
   * throws: a channel problem must not stop people being told.
   */
  private async queueForChannels(inputs: CreateNotificationInput[]): Promise<void> {
    const seen = new Set<string>();
    const rows: Array<typeof alertOutbox.$inferInsert> = [];
    for (const i of inputs) {
      const kind = String(i.kind);
      if (i.alertChannels === false || !isAlertKind(kind)) continue;
      const key = `${kind}\u0000${i.title}\u0000${i.body ?? ""}\u0000${i.link ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ kind, title: i.title, body: i.body ?? "", link: i.link ?? null, fanout: false });
    }
    if (rows.length === 0) return;
    try {
      await this.db.insert(alertOutbox).values(rows);
    } catch (err) {
      this.logger.warn(`queueing alerts for the channels failed: ${(err as Error).message}`);
    }
  }

  async create(input: CreateNotificationInput): Promise<void> {
    await this.queueForChannels([input]);
    if (input.excludeActorId && input.excludeActorId === input.recipientUserId) return;
    try {
      const [recipient] = await this.db
        .select({ email: users.email, muted: users.mutedNotificationKinds })
        .from(users)
        .where(
          and(
            eq(users.id, input.recipientUserId),
            isNull(users.deletedAt),
            eq(users.isActive, true),
          ),
        )
        .limit(1);
      // No live account for this id (deleted or disabled) — send nothing. The
      // in-app insert below doesn't otherwise depend on this row, so without
      // this guard a tombstoned/disabled user would still accrue in-app rows.
      if (!recipient) return;
      // Legacy muted-list takes precedence (entirely off for this kind).
      if (recipient.muted?.includes(String(input.kind))) return;

      // Per-kind channel matrix. A missing row means "use defaults"
      // (in-app + email) — same as the pre-matrix behaviour.
      const [pref] = await this.db
        .select({ channels: notificationPrefs.channels })
        .from(notificationPrefs)
        .where(
          and(
            eq(notificationPrefs.userId, input.recipientUserId),
            eq(notificationPrefs.kind, String(input.kind)),
          ),
        )
        .limit(1);
      const ch = resolveChannels(pref?.channels);

      if (ch.inApp) {
        const [row] = await this.db
          .insert(notifications)
          .values({
            recipientUserId: input.recipientUserId,
            kind: input.kind,
            title: input.title,
            body: input.body ?? "",
            link: input.link ?? null,
          })
          .returning();
        if (row) {
          this.realtime.toUser(input.recipientUserId, "notification:new", row);
        }
      }

      const wantsEmail = ch.email && input.email !== false && !!recipient.email;
      const wantsPush = ch.push && input.push !== false;
      if (wantsEmail || wantsPush) {
        const [delivery, tz] = await Promise.all([this.delivery.get(input.recipientUserId), this.delivery.zone()]);
        const now = new Date();
        if (wantsPush && pushAllowed(String(input.kind), delivery, now, tz)) {
          void this.push.send([input.recipientUserId], pushPayloadFor(input));
        }
        if (wantsEmail) {
          if (emailReleaseAt(String(input.kind), now, delivery, tz).getTime() > now.getTime()) {
            await this.hold([input]);
          } else {
            await this.sendEmail(recipient.email, input, await this.emailContext(input.ticketNumber !== undefined));
          }
        }
      }
    } catch (err) {
      // Notifications must never break the action that triggered them.
      this.logger.warn(`notifications.create failed: ${(err as Error).message}`);
    }
  }

  /**
   * Bulk variant of `create` for fan-out scenarios (wiki page change, ticket
   * comment with multiple watchers). One recipient-lookup query, one INSERT,
   * one mailer call per recipient. Replaces a loop of N×3 sequential queries
   * with 2 queries flat — meaningful for ACLs in the dozens.
   *
   * Behaviour matches `create`: per-user mute respected, self-notify skipped,
   * realtime + mailer fired per recipient.
   */
  async createMany(inputs: CreateNotificationInput[]): Promise<void> {
    if (inputs.length === 0) return;
    await this.queueForChannels(inputs);
    try {
      // Filter self-notifies before any DB work.
      const work = inputs.filter(
        (i) => !(i.excludeActorId && i.excludeActorId === i.recipientUserId),
      );
      if (work.length === 0) return;

      // One lookup for all distinct recipient IDs.
      const recipientIds = Array.from(new Set(work.map((w) => w.recipientUserId)));
      const [recipientRows, prefRows] = await Promise.all([
        this.db
          .select({ id: users.id, email: users.email, muted: users.mutedNotificationKinds })
          .from(users)
          // Live accounts only. Disabled (is_active=false) and soft-deleted
          // (deleted_at set) users are dropped here; the `!r` guard below then
          // skips both the in-app row and the email for them.
          .where(
            and(
              inArray(users.id, recipientIds),
              isNull(users.deletedAt),
              eq(users.isActive, true),
            ),
          ),
        this.db
          .select({
            userId: notificationPrefs.userId,
            kind: notificationPrefs.kind,
            channels: notificationPrefs.channels,
          })
          .from(notificationPrefs)
          .where(inArray(notificationPrefs.userId, recipientIds)),
      ]);
      const recipientById = new Map(recipientRows.map((r) => [r.id, r]));
      const prefByUserKind = new Map<string, string[]>();
      for (const p of prefRows) prefByUserKind.set(`${p.userId}|${p.kind}`, p.channels);

      // Decide per-work-item whether to write the in-app row and/or email.
      // Filter out fully-muted (legacy muted_notification_kinds) up front.
      const decided = work
        .map((w) => {
          const r = recipientById.get(w.recipientUserId);
          if (!r || r.muted?.includes(String(w.kind))) return null;
          const channels = prefByUserKind.get(`${w.recipientUserId}|${String(w.kind)}`);
          return { meta: w, ch: resolveChannels(channels), recipient: r };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
      if (decided.length === 0) return;

      // Bulk-insert only the in_app slice.
      const inAppRows = decided.filter((d) => d.ch.inApp);
      const inserted = inAppRows.length
        ? await this.db
            .insert(notifications)
            .values(
              inAppRows.map(({ meta }) => ({
                recipientUserId: meta.recipientUserId,
                kind: meta.kind,
                title: meta.title,
                body: meta.body ?? "",
                link: meta.link ?? null,
              })),
            )
            .returning()
        : [];
      for (let i = 0; i < inserted.length; i++) {
        const row = inserted[i];
        if (!row) continue;
        this.realtime.toUser(row.recipientUserId, "notification:new", row);
      }

      const needsDelivery = decided.filter((d) => (d.ch.email && d.meta.email !== false && d.recipient.email) || (d.ch.push && d.meta.push !== false));
      if (needsDelivery.length === 0) return;
      const ids = Array.from(new Set(needsDelivery.map((d) => d.meta.recipientUserId)));
      const [deliveryByUser, tz, withDevices] = await Promise.all([
        this.delivery.getMany(ids),
        this.delivery.zone(),
        this.push.usersWithDevices(needsDelivery.filter((d) => d.ch.push && d.meta.push !== false).map((d) => d.meta.recipientUserId)),
      ]);
      const now = new Date();
      const toHold: CreateNotificationInput[] = [];
      const toSend: Array<{ to: string; meta: CreateNotificationInput }> = [];
      for (const { meta, ch, recipient } of needsDelivery) {
        const delivery: NotificationDelivery = deliveryByUser.get(meta.recipientUserId) ?? DEFAULT_NOTIFICATION_DELIVERY;
        const kind = String(meta.kind);
        if (ch.push && meta.push !== false && withDevices.has(meta.recipientUserId) && pushAllowed(kind, delivery, now, tz)) {
          void this.push.send([meta.recipientUserId], pushPayloadFor(meta));
        }
        if (ch.email && meta.email !== false && recipient.email) {
          if (emailReleaseAt(kind, now, delivery, tz).getTime() > now.getTime()) toHold.push(meta);
          else toSend.push({ to: recipient.email, meta });
        }
      }
      if (toHold.length) await this.hold(toHold);
      if (toSend.length) {
        const ctx = await this.emailContext(toSend.some((t) => t.meta.ticketNumber !== undefined));
        for (const t of toSend) await this.sendEmail(t.to, t.meta, ctx);
      }
    } catch (err) {
      this.logger.warn(`notifications.createMany failed: ${(err as Error).message}`);
    }
  }

  /** Put emails aside until the person's quiet hours end or their daily summary time (`notification-release` sends them). */
  private async hold(items: CreateNotificationInput[]): Promise<void> {
    await this.db.insert(notificationHeld).values(
      items.map((i) => ({
        recipientUserId: i.recipientUserId,
        kind: String(i.kind),
        title: i.title,
        body: i.body ?? "",
        link: i.link ?? null,
        ticketNumber: i.ticketNumber ?? null,
      })),
    );
  }

  /** What every email of one batch shares: the site's name, its public address, and the help address for replies. */
  async emailContext(wantReply: boolean): Promise<EmailContext> {
    const [siteName, base, replyAddress] = await Promise.all([
      this.siteNameForEmail(),
      this.settings.publicBaseUrl(),
      wantReply ? this.helpAddress() : Promise.resolve(null),
    ]);
    return { siteName, base, replyAddress };
  }

  /** One notice as one email, queued for sending. A ticket notice carries `[#n]` and Reply-To when the mailbox is on. */
  async sendEmail(to: string, n: MailableNotice, ctx: EmailContext): Promise<void> {
    const href = absoluteEmailLink(ctx.base, n.link);
    const rendered = renderEmail({
      siteName: ctx.siteName,
      title: n.title,
      body: n.body ?? undefined,
      cta: href ? { label: "Open", href } : undefined,
    });
    const replyable = ctx.replyAddress !== null && n.ticketNumber !== undefined && n.ticketNumber !== null;
    await this.mailer.sendBestEffort({
      to,
      subject: replyable ? `${n.title} ${ticketSubjectToken(n.ticketNumber!)}` : n.title,
      text: rendered.text,
      html: rendered.html,
      ...(replyable ? { replyTo: ctx.replyAddress! } : {}),
    });
  }

  /** The help address to put in Reply-To, or null unless the helpdesk mailbox is switched on and has one. */
  private async helpAddress(): Promise<string | null> {
    try {
      const [enabled, address] = await Promise.all([this.settings.get(INBOUND_KEYS.enabled), this.settings.get(INBOUND_KEYS.address)]);
      return enabled === true && typeof address === "string" && address.trim() !== "" ? address.trim() : null;
    } catch {
      return null;
    }
  }

  async list(userId: string, opts: { unread?: boolean; limit: number }) {
    const conds = [eq(notifications.recipientUserId, userId)];
    if (opts.unread === true) conds.push(isNull(notifications.readAt));
    return this.db
      .select()
      .from(notifications)
      .where(and(...conds))
      .orderBy(desc(notifications.createdAt))
      .limit(opts.limit);
  }

  async unreadCount(userId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(notifications)
      .where(and(eq(notifications.recipientUserId, userId), isNull(notifications.readAt)));
    return Number(row?.n ?? 0);
  }

  async markRead(userId: string, id: string): Promise<void> {
    const [row] = await this.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.id, id), eq(notifications.recipientUserId, userId)))
      .returning();
    if (!row) throw new NotFoundException("Notification not found");
  }

  async markAllRead(userId: string): Promise<void> {
    await this.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.recipientUserId, userId), isNull(notifications.readAt)));
  }

  async dismiss(userId: string, id: string): Promise<void> {
    const [row] = await this.db
      .delete(notifications)
      .where(and(eq(notifications.id, id), eq(notifications.recipientUserId, userId)))
      .returning();
    if (!row) throw new NotFoundException("Notification not found");
  }
}
