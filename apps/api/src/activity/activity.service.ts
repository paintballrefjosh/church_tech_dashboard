import { Injectable, Inject, Logger } from "@nestjs/common";
import { and, desc, eq, inArray, or, type SQL } from "drizzle-orm";
import { PERMISSIONS } from "@church/shared";
import { DB, type Db } from "../db/db.module";
import { activityEvents, groupMemberships, tickets, users, wikiPageAcl, wikiPages } from "../db/schema";
import type { AuthenticatedUser } from "../auth/current-user.decorator";

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

  /**
   * The events this person may see. The feed carries titles and excerpts of tickets, notes and wiki pages,
   * so each resource type is held to that resource's own read rule (the same ones `TicketsService.getById`
   * and `WikiService.readablePredicate` apply): a private note is only ever its owner's, a ticket is its
   * creator's or a `tickets:read:any` holder's, a wiki page follows its visibility and ACL, and
   * infrastructure events need `monitors:read:any`. A type this does not know is shown to its actor only,
   * so a new kind of event is private until it is added here.
   */
  private visibleTo(user: AuthenticatedUser): SQL {
    const perms = new Set(user.permissions);
    const mine = eq(activityEvents.actorUserId, user.id);
    const branches: SQL[] = [mine];

    branches.push(
      and(
        eq(activityEvents.resourceType, "ticket"),
        perms.has(PERMISSIONS.TICKETS_READ_ANY)
          ? undefined
          : inArray(
              activityEvents.resourceId,
              this.db.select({ id: tickets.id }).from(tickets).where(eq(tickets.createdByUserId, user.id)),
            ),
      )!,
    );

    branches.push(
      and(
        eq(activityEvents.resourceType, "wiki_page"),
        perms.has(PERMISSIONS.WIKI_READ_ANY)
          ? undefined
          : inArray(
              activityEvents.resourceId,
              this.db
                .select({ id: wikiPages.id })
                .from(wikiPages)
                .where(
                  or(
                    eq(wikiPages.visibility, "public"),
                    eq(wikiPages.ownerUserId, user.id),
                    inArray(
                      wikiPages.id,
                      this.db
                        .select({ id: wikiPageAcl.pageId })
                        .from(wikiPageAcl)
                        .innerJoin(groupMemberships, eq(groupMemberships.groupId, wikiPageAcl.groupId))
                        .where(eq(groupMemberships.userId, user.id)),
                    ),
                  ),
                ),
            ),
      )!,
    );

    if (perms.has(PERMISSIONS.MONITORS_READ_ANY)) {
      branches.push(inArray(activityEvents.resourceType, ["infra_target", "monitor"]));
    }
    return or(...branches)!;
  }

  list(user: AuthenticatedUser, limit = 50) {
    return this.db
      .select()
      .from(activityEvents)
      .where(this.visibleTo(user))
      .orderBy(desc(activityEvents.ts))
      .limit(Math.max(1, Math.min(200, limit)));
  }
}
