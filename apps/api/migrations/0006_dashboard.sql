CREATE TABLE IF NOT EXISTS "dashboard_layouts" (
    "user_id" uuid PRIMARY KEY NOT NULL,
    "layout" jsonb NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL,
    CONSTRAINT "dashboard_layouts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action
);
