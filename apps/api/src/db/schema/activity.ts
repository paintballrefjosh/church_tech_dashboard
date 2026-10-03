import { pgTable, text, timestamp, uuid, index } from "drizzle-orm/pg-core";

/**
 * Curated activity feed. Distinct from `audit_log`: that captures every
 * mutating route call (admin + user, including denials/diffs), this is the
 * user-facing "what's happening" timeline.
 *
 * Each row is a single human-friendly event. Sensitive bits (admin/system
 * stuff) are deliberately *not* recorded here — anyone with `monitors:read:any`
 * or similar can see the feed.
 */
export const activityEvents = pgTable(
  "activity_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actorUserId: uuid("actor_user_id"),
    actorEmail: text("actor_email"),
    /**
     * Verb tying together a kind + action — e.g. "note.created",
     * "ticket.commented", "wiki.updated", "monitor.incident.opened".
     * Free-form so new modules can record without a schema change.
     */
    action: text("action").notNull(),
    /** Resource shape — "ticket" | "note" | "wiki_page" | "monitor". */
    resourceType: text("resource_type").notNull(),
    resourceId: uuid("resource_id"),
    /** Short noun-phrase rendered as the headline ("My ticket", "Worship setlist"). */
    title: text("title").notNull(),
    /** Optional one-line summary (comment body, status change, etc.). */
    summary: text("summary"),
    /** Deep link the feed renders as a clickable target. */
    link: text("link"),
    ts: timestamp("ts").notNull().defaultNow(),
  },
  (t) => ({
    tsIdx: index("activity_events_ts_idx").on(t.ts),
    resourceIdx: index("activity_events_resource_idx").on(t.resourceType, t.resourceId),
  }),
);
