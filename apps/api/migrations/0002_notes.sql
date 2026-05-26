CREATE TABLE IF NOT EXISTS "notes" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "owner_user_id" uuid NOT NULL,
    "title" text DEFAULT '' NOT NULL,
    "body" text DEFAULT '' NOT NULL,
    "color" text DEFAULT 'default' NOT NULL,
    "pinned" boolean DEFAULT false NOT NULL,
    "archived" boolean DEFAULT false NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL,
    CONSTRAINT "notes_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action
);

CREATE INDEX IF NOT EXISTS "notes_owner_idx" ON "notes" ("owner_user_id");
CREATE INDEX IF NOT EXISTS "notes_updated_idx" ON "notes" ("updated_at");
