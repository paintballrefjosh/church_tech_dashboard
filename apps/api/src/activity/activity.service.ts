import { Injectable, Inject, Logger } from "@nestjs/common";
import { desc, eq } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { activityEvents, users } from "../db/schema";

export interface RecordActivityInput {
  actorUserId?: string | null;
  action: string; // e.g. "note.created"
  resourceType: string; // "ticket" | "note" | "wiki_page" | "monitor"
  resourceId?: string | null;
  title: string;
  summary?: string | null;
  link?: string | null;
}

@Injectable()
export class ActivityService {
  private readonly logger = new Logger(ActivityService.name);

  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Record a single event. Best-effort: never throws back into the calling
   * service. We resolve actorEmail lazily so failures resolving the user
   * don't drop the event.
   */
  async record(input: RecordActivityInput): Promise<void> {
    try {
      let actorEmail: string | null = null;
      if (input.actorUserId) {
        const [u] = await this.db
          .select({ email: users.email })
          .from(users)
          .where(eq(users.id, input.actorUserId))
          .limit(1);
        actorEmail = u?.email ?? null;
      }
      await this.db.insert(activityEvents).values({
        actorUserId: input.actorUserId ?? null,
        actorEmail,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        title: input.title,
        summary: input.summary ?? null,
        link: input.link ?? null,
      });
    } catch (err) {
      this.logger.warn(`activity.record failed: ${(err as Error).message}`);
    }
  }

  list(limit = 50) {
    return this.db
      .select()
      .from(activityEvents)
      .orderBy(desc(activityEvents.ts))
      .limit(Math.max(1, Math.min(200, limit)));
  }
}
