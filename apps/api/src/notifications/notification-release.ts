import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import {
  DEFAULT_NOTIFICATION_DELIVERY,
  HELD_EMAIL_MAX_ITEMS,
  emailReleaseAt,
  heldReason,
  type NotificationDelivery,
} from "@church/shared";
import { DB, type Db } from "../db/db.module";
import { notificationHeld, users } from "../db/schema";
import { ClusterJobs } from "../cluster/cluster-jobs.service";
import { MailerService } from "../mailer/mailer.service";
import { renderEmail } from "../mailer/templates";
import { NotificationDeliveryService } from "./notification-delivery.service";
import { NotificationsService } from "./notifications.service";

/** Mail held longer than this goes out whatever the settings say: nothing waits for days. */
export const HELD_MAX_AGE_MS = 3 * 86_400_000;
const BATCH = 2000;

export interface ReleaseRun {
  /** People who were sent something. */
  people: number;
  /** Emails sent, a summary counting as one. */
  emails: number;
  /** Held notices released. */
  notices: number;
}

/**
 * Sends the email that was held for quiet hours or a daily summary. Whether a held notice is due is worked out from the
 * person's CURRENT choices (`emailReleaseAt`), so changing them applies to what is waiting. Rows are CLAIMED by deleting them
 * before anything is sent (two nodes never send twice; a crash between the claim and the queue loses at most that one email,
 * and the bell still has the notice). One notice goes out as itself, two or more as a single summary.
 */
@Injectable()
export class NotificationRelease implements OnModuleInit {
  private readonly logger = new Logger(NotificationRelease.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jobs: ClusterJobs,
    private readonly delivery: NotificationDeliveryService,
    private readonly notifications: NotificationsService,
    private readonly mailer: MailerService,
  ) {}

  onModuleInit(): void {
    this.jobs.register({ name: "notification-release", everyMs: 60_000, initialDelayMs: 45_000, run: async () => void (await this.run()) });
  }

  async run(now: Date = new Date()): Promise<ReleaseRun> {
    const result: ReleaseRun = { people: 0, emails: 0, notices: 0 };
    const held = await this.db.select().from(notificationHeld).orderBy(asc(notificationHeld.createdAt)).limit(BATCH);
    if (held.length === 0) return result;

    const byUser = new Map<string, typeof held>();
    for (const h of held) {
      const list = byUser.get(h.recipientUserId);
      if (list) list.push(h);
      else byUser.set(h.recipientUserId, [h]);
    }
    const [settings, tz] = await Promise.all([this.delivery.getMany([...byUser.keys()]), this.delivery.zone()]);

    for (const [userId, rows] of byUser) {
      const d: NotificationDelivery = settings.get(userId) ?? DEFAULT_NOTIFICATION_DELIVERY;
      const due = rows.filter(
        (r) => now.getTime() - r.createdAt.getTime() >= HELD_MAX_AGE_MS || emailReleaseAt(r.kind, r.createdAt, d, tz).getTime() <= now.getTime(),
      );
      if (due.length === 0) continue;
      // Claim: only the rows this node actually deleted are its to send.
      const claimed = await this.db
        .delete(notificationHeld)
        .where(inArray(notificationHeld.id, due.map((r) => r.id)))
        .returning();
      if (claimed.length === 0) continue;
      try {
        const sent = await this.sendTo(userId, claimed.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()), d);
        if (sent) {
          result.people++;
          result.emails++;
          result.notices += claimed.length;
        }
      } catch (err) {
        this.logger.warn(`releasing held email for ${userId} failed: ${(err as Error).message}`);
      }
    }
    return result;
  }

  private async sendTo(userId: string, rows: Array<typeof notificationHeld.$inferSelect>, d: NotificationDelivery): Promise<boolean> {
    const [person] = await this.db
      .select({ email: users.email })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt), eq(users.isActive, true)))
      .limit(1);
    if (!person?.email) return false;

    const first = rows[0]!;
    if (rows.length === 1) {
      const ctx = await this.notifications.emailContext(first.ticketNumber !== null);
      await this.notifications.sendEmail(person.email, { title: first.title, body: first.body, link: first.link, ticketNumber: first.ticketNumber }, ctx);
      return true;
    }

    const ctx = await this.notifications.emailContext(false);
    const shown = rows.slice(0, HELD_EMAIL_MAX_ITEMS);
    const items = shown.map((r) => {
      const href = absolute(ctx.base, r.link);
      return { title: r.title, body: r.body || undefined, ...(href ? { href } : {}) };
    });
    const digest = heldReason(d) === "digest";
    const home = absolute(ctx.base, "/notifications") ?? absolute(ctx.base, "/");
    const title = digest ? `Your summary: ${rows.length} notifications` : `${rows.length} notifications while you were away`;
    const rendered = renderEmail({
      siteName: ctx.siteName,
      title,
      body: digest ? "Here is what happened since your last summary." : "These arrived during your quiet hours.",
      items,
      more: rows.length - shown.length,
      cta: home ? { label: "Open notifications", href: home } : undefined,
    });
    await this.mailer.sendBestEffort({ to: person.email, subject: `${ctx.siteName}: ${title}`, text: rendered.text, html: rendered.html });
    return true;
  }
}

function absolute(base: string, link: string | null | undefined): string | undefined {
  if (!link) return undefined;
  if (/^https?:\/\//i.test(link)) return link;
  if (!base) return undefined;
  return `${base}${link.startsWith("/") ? "" : "/"}${link}`;
}
