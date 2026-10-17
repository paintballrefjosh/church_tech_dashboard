-- Wiki upkeep: when a page was last confirmed correct (and by whom), its own review interval, the review notice already sent,
-- and page templates. Additive: older code ignores the columns and the table.
ALTER TABLE "wiki_pages" ADD COLUMN IF NOT EXISTS "last_reviewed_at" timestamp;
--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD COLUMN IF NOT EXISTS "last_reviewed_by" uuid REFERENCES "users"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD COLUMN IF NOT EXISTS "review_interval_days" integer;
--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD COLUMN IF NOT EXISTS "review_notified_at" timestamp;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wiki_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"body" text NOT NULL,
	"created_by_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
