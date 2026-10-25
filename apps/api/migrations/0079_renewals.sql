-- Renewals (licences, domains, warranties, subscriptions) with their reminder marker. Additive: older code ignores it.
CREATE TABLE IF NOT EXISTS "renewals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"category" text DEFAULT 'licence' NOT NULL,
	"vendor" text DEFAULT '' NOT NULL,
	"renews_on" text NOT NULL,
	"cost" real,
	"auto_renew" boolean DEFAULT false NOT NULL,
	"owner_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
	"notes" text DEFAULT '' NOT NULL,
	"remind_days" jsonb DEFAULT '[30,7]'::jsonb NOT NULL,
	"reminded_for" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "renewals_renews_on_idx" ON "renewals" USING btree ("renews_on");
