CREATE TABLE IF NOT EXISTS "wiki_pages" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "title" text NOT NULL,
    "body" text DEFAULT '' NOT NULL,
    "owner_user_id" uuid NOT NULL,
    "visibility" text DEFAULT 'public' NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL,
    CONSTRAINT "wiki_pages_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action
);

CREATE INDEX IF NOT EXISTS "wiki_pages_owner_idx" ON "wiki_pages" ("owner_user_id");
CREATE INDEX IF NOT EXISTS "wiki_pages_updated_idx" ON "wiki_pages" ("updated_at");

CREATE TABLE IF NOT EXISTS "wiki_page_acl" (
    "page_id" uuid NOT NULL,
    "group_id" uuid NOT NULL,
    "can_edit" boolean DEFAULT false NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    CONSTRAINT "wiki_page_acl_page_id_group_id_pk" PRIMARY KEY("page_id","group_id"),
    CONSTRAINT "wiki_page_acl_page_id_wiki_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "wiki_pages"("id") ON DELETE cascade ON UPDATE no action,
    CONSTRAINT "wiki_page_acl_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE cascade ON UPDATE no action
);

CREATE TABLE IF NOT EXISTS "wiki_revisions" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "page_id" uuid NOT NULL,
    "title" text NOT NULL,
    "body" text NOT NULL,
    "editor_user_id" uuid,
    "summary" text,
    "created_at" timestamp DEFAULT now() NOT NULL,
    CONSTRAINT "wiki_revisions_page_id_wiki_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "wiki_pages"("id") ON DELETE cascade ON UPDATE no action,
    CONSTRAINT "wiki_revisions_editor_user_id_users_id_fk" FOREIGN KEY ("editor_user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action
);

CREATE INDEX IF NOT EXISTS "wiki_revisions_page_idx" ON "wiki_revisions" ("page_id", "created_at");
