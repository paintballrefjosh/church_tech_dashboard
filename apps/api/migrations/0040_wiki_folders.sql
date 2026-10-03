-- Wiki folders: pure organizational containers (no content/ACL of their own).
-- FKs are plain ALTER TABLE ADD CONSTRAINT (no DO-block) because CockroachDB
-- v24.2 rejects anonymous PL/pgSQL.
CREATE TABLE IF NOT EXISTS "wiki_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"parent_folder_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD COLUMN "parent_folder_id" uuid;--> statement-breakpoint
ALTER TABLE "wiki_folders" ADD CONSTRAINT "wiki_folders_parent_folder_id_wiki_folders_id_fk" FOREIGN KEY ("parent_folder_id") REFERENCES "wiki_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wiki_folders_parent_idx" ON "wiki_folders" USING btree ("parent_folder_id");--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_parent_folder_id_wiki_folders_id_fk" FOREIGN KEY ("parent_folder_id") REFERENCES "wiki_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wiki_pages_parent_folder_idx" ON "wiki_pages" USING btree ("parent_folder_id");
