import { pgTable, text, timestamp, uuid, index } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * One-time-use tokens for email-based flows. Two kinds today:
 *  - "invite"  → operator created a user but never set a password; the
 *                recipient lands on /accept-invite?token=... to set theirs.
 *  - "reset"   → user clicked "forgot password"; they land on /reset-password.
 *
 * Tokens are stored as a SHA-256 hash so a DB read doesn't hand out usable
 * tokens. The plaintext only exists in the email link.
 */
export const authTokens = pgTable(
  "auth_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // 'invite' | 'reset'
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index("auth_tokens_user_idx").on(t.userId),
    expiresIdx: index("auth_tokens_expires_idx").on(t.expiresAt),
  }),
);
