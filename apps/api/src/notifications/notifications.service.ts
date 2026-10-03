import { Injectable, Inject, NotFoundException, Logger } from "@nestjs/common";
import { and, desc, eq, isNull, count, inArray } from "drizzle-orm";
import type { NotificationKind } from "@church/shared";
import { DB, type Db } from "../db/db.module";
import { notifications, notificationPrefs, users } from "../db/schema";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { MailerService } from "../mailer/mailer.service";
import { SettingsService } from "../settings/settings.service";
import { renderEmail } from "../mailer/templates";

/**
 * Default channels when a user has no `notification_prefs` row for this kind.
 * Matches the legacy behaviour (in-app + email) so existing users feel no
 * change after the per-kind matrix rolls out.
 */
const DEFAULT_CHANNELS: ReadonlyArray<string> = ["in_app", "email"];

interface ResolvedChannels {
  inApp: boolean;
  email: boolean;
}

function resolveChannels(channels: string[] | undefined): ResolvedChannels {
  const list = channels ?? DEFAULT_CHANNELS;
  return { inApp: list.includes("in_app"), email: list.includes("email") };
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
  /** Skip create entirely if recipient === actor. */
  excludeActorId?: string;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly realtime: RealtimeGateway,
    private readonly mailer: MailerService,
    private readonly settings: SettingsService,
  ) {}

  /** Best-effort site name lookup for email rendering; falls back to a default. */
  private async siteNameForEmail(): Promise<string> {
    const v = await this.settings.get("site.name");
    return typeof v === "string" && v.length > 0 ? v : "Church Dashboard";
  }

  async create(input: CreateNotificationInput): Promise<void> {
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

      if (ch.email && input.email !== false && recipient.email) {
        const siteName = await this.siteNameForEmail();
        const href = absoluteEmailLink(await this.settings.publicBaseUrl(), input.link);
        const rendered = renderEmail({
          siteName,
          title: input.title,
          body: input.body,
          cta: href ? { label: "Open", href } : undefined,
        });
        void this.mailer.sendBestEffort({
          to: recipient.email,
          subject: input.title,
          text: rendered.text,
          html: rendered.html,
        });
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

      const siteName = await this.siteNameForEmail();
      const base = await this.settings.publicBaseUrl();
      for (const { meta, ch, recipient } of decided) {
        if (!ch.email || meta.email === false || !recipient.email) continue;
        const href = absoluteEmailLink(base, meta.link);
        const rendered = renderEmail({
          siteName,
          title: meta.title,
          body: meta.body,
          cta: href ? { label: "Open", href } : undefined,
        });
        void this.mailer.sendBestEffort({
          to: recipient.email,
          subject: meta.title,
          text: rendered.text,
          html: rendered.html,
        });
      }
    } catch (err) {
      this.logger.warn(`notifications.createMany failed: ${(err as Error).message}`);
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
