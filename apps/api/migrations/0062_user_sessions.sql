-- One row per signed-in browser, so a person can see and end their sessions one by one. The id is the `sid` claim the web
-- puts in the session cookie; rows are created by the API the first time it sees one. Additive: older cookies have no sid.
CREATE TABLE IF NOT EXISTS "user_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "public"."users"("id") ON DELETE cascade,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"ip" text,
	"user_agent" text,
	"revoked_at" timestamp
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_sessions_user_idx" ON "user_sessions" USING btree ("user_id","last_seen_at");
