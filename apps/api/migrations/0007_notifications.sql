CREATE TABLE IF NOT EXISTS "notifications" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "recipient_user_id" uuid NOT NULL,
    "kind" text NOT NULL,
    "title" text NOT NULL,
    "body" text DEFAULT '' NOT NULL,
    "link" text,
    "read_at" timestamp,
    "created_at" timestamp DEFAULT now() NOT NULL,
    CONSTRAINT "notifications_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action
);

CREATE INDEX IF NOT EXISTS "notifications_recipient_idx" ON "notifications" ("recipient_user_id", "created_at");
CREATE INDEX IF NOT EXISTS "notifications_unread_idx" ON "notifications" ("recipient_user_id", "read_at");
