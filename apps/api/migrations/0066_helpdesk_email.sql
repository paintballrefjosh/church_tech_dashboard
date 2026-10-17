-- Helpdesk email: the record of messages the mailbox has handled.
-- Additive: a new table, nothing existing changes.
CREATE TABLE IF NOT EXISTS "ticket_inbound_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" text NOT NULL,
	"handled_at" timestamp DEFAULT now() NOT NULL,
	"from_address" text DEFAULT '' NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"ticket_id" uuid REFERENCES "tickets"("id") ON DELETE set null,
	"attempts" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ticket_inbound_log_message_idx" ON "ticket_inbound_log" USING btree ("message_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ticket_inbound_log_handled_idx" ON "ticket_inbound_log" USING btree ("handled_at");
