import { Injectable, Inject, NotFoundException, Logger } from "@nestjs/common";
import { and, desc, eq, isNull, count } from "drizzle-orm";
import type { NotificationKind } from "@church/shared";
import { DB, type Db } from "../db/db.module";
import { notifications, users } from "../db/schema";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { MailerService } from "../mailer/mailer.service";

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
  ) {}

  async create(input: CreateNotificationInput): Promise<void> {
    if (input.excludeActorId && input.excludeActorId === input.recipientUserId) return;
    try {
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
      if (!row) return;
      // Push to any open socket for the recipient. The bell subscribes via the
      // existing user:{id} room; no per-user rooms needed.
      this.realtime.toUser(input.recipientUserId, "notification:new", row);

      if (input.email !== false) {
        const [u] = await this.db
          .select({ email: users.email })
          .from(users)
          .where(eq(users.id, input.recipientUserId))
          .limit(1);
        if (u?.email) {
          const text = [input.title, "", input.body ?? "", input.link ? `\n${input.link}` : ""]
            .filter(Boolean)
            .join("\n");
          // fire-and-forget — never blocks the calling request
          void this.mailer.sendBestEffort({ to: u.email, subject: input.title, text });
        }
      }
    } catch (err) {
      // Notifications must never break the action that triggered them.
      this.logger.warn(`notifications.create failed: ${(err as Error).message}`);
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
