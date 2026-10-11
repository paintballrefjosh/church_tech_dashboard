CREATE TABLE IF NOT EXISTS "dashboard_prefs" (
	"user_id" uuid PRIMARY KEY NOT NULL REFERENCES "public"."users"("id") ON DELETE cascade,
	"theme" text,
	"sections" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
