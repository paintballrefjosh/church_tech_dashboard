-- The assistant, phases 2-3 (docs/assistant.md): proposed actions and feedback on an answer, and anonymous per-answer
-- figures for the usage page (no text, no person), kept apart from conversations so they outlive history retention.
ALTER TABLE "assistant_messages" ADD COLUMN IF NOT EXISTS "actions" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "assistant_messages" ADD COLUMN IF NOT EXISTS "rating" smallint;
--> statement-breakpoint
ALTER TABLE "assistant_messages" ADD COLUMN IF NOT EXISTS "feedback_comment" text;
--> statement-breakpoint
ALTER TABLE "assistant_messages" ADD COLUMN IF NOT EXISTS "answer_id" uuid;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assistant_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"model" text,
	"prompt_version" integer,
	"outcome" text NOT NULL,
	"error_kind" text,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"first_token_ms" integer,
	"lookups" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"proposals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"not_found" boolean DEFAULT false NOT NULL,
	"rating" smallint
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assistant_answers_day_idx" ON "assistant_answers" ("day");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assistant_answers_created_idx" ON "assistant_answers" ("created_at");
