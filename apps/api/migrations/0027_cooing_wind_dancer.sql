CREATE TABLE IF NOT EXISTS "notification_prefs" (
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"channels" text[] DEFAULT '{}' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "notification_prefs_user_id_kind_pk" PRIMARY KEY("user_id","kind")
);
--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
-- See note in 0026: unwrap drizzle-kit's `DO $$ ... EXCEPTION WHEN
-- duplicate_object` blocks because Cockroach has no PL/pgSQL DO. Both target
-- columns (notification_prefs.user_id, wiki_pages.parent_id) are added in
-- this same migration, so a plain ADD CONSTRAINT is safe.
ALTER TABLE "notification_prefs" ADD CONSTRAINT "notification_prefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_parent_id_wiki_pages_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."wiki_pages"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wiki_pages_parent_idx" ON "wiki_pages" USING btree ("parent_id");