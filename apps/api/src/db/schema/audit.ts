import { pgTable, text, timestamp, uuid, jsonb, index } from "drizzle-orm/pg-core";
import { users } from "./users";
import { apiTokens } from "./api-tokens";

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorEmail: text("actor_email"),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    // Set when the request authenticated with an API token rather than a session.
    apiTokenId: uuid("api_token_id").references(() => apiTokens.id, { onDelete: "set null" }),
    ts: timestamp("ts").notNull().defaultNow(),
  },
  (t) => ({
    tsIdx: index("audit_log_ts_idx").on(t.ts),
    actorIdx: index("audit_log_actor_idx").on(t.actorUserId),
    resourceIdx: index("audit_log_resource_idx").on(t.resourceType, t.resourceId),
  })
);
