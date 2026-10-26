import { pgTable, text, integer, real, smallint, boolean, timestamp, uuid, jsonb, index, primaryKey } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * The assistant's conversations (docs/assistant.md section 9). Private to their owner; deleted with the account and after
 * `assistant.history_retention_days`. Lookups are recorded by name and size only, never the rows they returned, so
 * retained history holds no device or ticket content copied out of its own tables. All `skip` in the backup registry.
 */
export const assistantConversations = pgTable(
  "assistant_conversations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull().default(""),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({ userIdx: index("assistant_conversations_user_idx").on(t.userId, t.updatedAt) }),
);

export const assistantMessages = pgTable(
  "assistant_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => assistantConversations.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // user | assistant
    content: text("content").notNull().default(""),
    sources: jsonb("sources").notNull().default([]), // [{ title, url }]
    lookups: jsonb("lookups").notNull().default([]), // [{ tool, ok, ms, chars }]
    model: text("model"),
    promptVersion: integer("prompt_version"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    outcome: text("outcome").notNull().default("ok"), // ok | partial | error | refused | stopped
    errorKind: text("error_kind"),
    /** Proposed actions (`AssistantProposal[]`): what the model proposed and what the person decided. */
    actions: jsonb("actions").notNull().default([]),
    /** The person's thumbs: 1 up, -1 down. */
    rating: smallint("rating"),
    feedbackComment: text("feedback_comment"),
    /** The row of `assistant_answers` for this answer (its rating is copied there). */
    answerId: uuid("answer_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({ convIdx: index("assistant_messages_conversation_idx").on(t.conversationId, t.createdAt) }),
);

/** Per person per day: the budget and the limits add these up (one atomic upsert per answer). */
export const assistantUsageDaily = pgTable(
  "assistant_usage_daily",
  {
    day: text("day").notNull(), // YYYY-MM-DD on the site's calendar
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    questions: integer("questions").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cost: real("cost").notNull().default(0),
    errors: integer("errors").notNull().default(0),
  },
  (t) => ({ pk: primaryKey({ columns: [t.day, t.userId] }) }),
);

/**
 * One row per answer for the usage page: timings, outcome, which lookups and proposals, the rating. No question or answer
 * text and no person, so it is kept (`assistant-retention`, 400 days) whatever the history retention is.
 */
export const assistantAnswers = pgTable(
  "assistant_answers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    day: text("day").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    model: text("model"),
    promptVersion: integer("prompt_version"),
    outcome: text("outcome").notNull(),
    errorKind: text("error_kind"),
    latencyMs: integer("latency_ms").notNull().default(0),
    firstTokenMs: integer("first_token_ms"),
    lookups: jsonb("lookups").notNull().default([]), // tool names
    proposals: jsonb("proposals").notNull().default([]), // kinds
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    notFound: boolean("not_found").notNull().default(false),
    rating: smallint("rating"),
  },
  (t) => ({ dayIdx: index("assistant_answers_day_idx").on(t.day), createdIdx: index("assistant_answers_created_idx").on(t.createdAt) }),
);
