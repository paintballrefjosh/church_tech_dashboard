-- Helpdesk: waiting on the requester (pauses the SLA clocks), SLA notices already sent, canned replies.
-- Additive: older code ignores the columns and the table.
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "waiting_since" timestamp;
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "waited_ms" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "response_warned_at" timestamp;
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "response_breached_at" timestamp;
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "resolution_warned_at" timestamp;
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "resolution_breached_at" timestamp;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ticket_canned_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"created_by_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
