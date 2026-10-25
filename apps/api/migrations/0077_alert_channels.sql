-- Alert channels (team chat, ntfy, Pushover, SMS, webhooks) and the outbox that feeds them. Additive: older code ignores
-- both tables (an older probe worker keeps writing bell rows itself).
CREATE TABLE IF NOT EXISTS "alert_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"events" text DEFAULT 'outages' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret" text,
	"last_sent_at" timestamp,
	"last_error" text,
	"last_error_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "alert_channels_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "alert_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"link" text,
	"fanout" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"claimed_until" timestamp,
	"attempts" integer DEFAULT 0 NOT NULL,
	"sent_at" timestamp,
	"last_error" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "alert_outbox_pending_idx" ON "alert_outbox" USING btree ("sent_at","created_at");
