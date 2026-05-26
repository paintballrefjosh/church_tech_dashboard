CREATE TABLE IF NOT EXISTS "attachments" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "parent_type" text NOT NULL,
    "parent_id" uuid NOT NULL,
    "uploader_user_id" uuid,
    "filename" text NOT NULL,
    "content_type" text NOT NULL,
    "size_bytes" bigint NOT NULL,
    "storage_key" text NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    CONSTRAINT "attachments_storage_key_unique" UNIQUE("storage_key"),
    CONSTRAINT "attachments_uploader_user_id_users_id_fk" FOREIGN KEY ("uploader_user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action
);

CREATE INDEX IF NOT EXISTS "attachments_parent_idx" ON "attachments" ("parent_type", "parent_id");
CREATE INDEX IF NOT EXISTS "attachments_uploader_idx" ON "attachments" ("uploader_user_id");
