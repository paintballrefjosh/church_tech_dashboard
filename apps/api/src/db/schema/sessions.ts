import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * One row per browser sign-in. The id is a random value the web puts in the session cookie's JWT (`sid`) when
 * someone signs in; the API creates the row the first time it sees it and keeps `last_seen_at`, address and browser
 * current (at most every few minutes). Setting `revoked_at` ends that one session; the cookie is refused from then on.
 * Cookies issued before this table existed have no `sid` and are not listed (they end with "sign out everywhere").
 * Runtime state: not part of backups.
 */
export const userSessions = pgTable(
  "user_sessions",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    revokedAt: timestamp("revoked_at"),
  },
  (t) => ({
    userIdx: index("user_sessions_user_idx").on(t.userId, t.lastSeenAt),
  }),
);
