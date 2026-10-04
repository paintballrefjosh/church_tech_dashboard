import { boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * Personal API tokens. Only the SHA-256 hash of the token is stored, plus its
 * first few characters for display. A token acts as its owner, narrowed by
 * `read_only` and `modules` (null = every module). Revoking sets `revoked_at`;
 * rows are never deleted by the app, so audit_log.api_token_id keeps resolving.
 */
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    tokenPrefix: text("token_prefix"),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    readOnly: boolean("read_only").notNull().default(false),
    modules: text("modules").array(),
    expiresAt: timestamp("expires_at"),
    lastUsedAt: timestamp("last_used_at"),
    lastUsedIp: text("last_used_ip"),
    revokedAt: timestamp("revoked_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index("api_tokens_user_idx").on(t.userId),
  }),
);
