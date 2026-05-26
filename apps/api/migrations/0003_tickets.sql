CREATE SEQUENCE IF NOT EXISTS "tickets_number_seq" START 1;

CREATE TABLE IF NOT EXISTS "tickets" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "number" bigint NOT NULL DEFAULT nextval('tickets_number_seq'),
    "title" text NOT NULL,
    "description" text DEFAULT '' NOT NULL,
    "status" text DEFAULT 'open' NOT NULL,
    "priority" text DEFAULT 'normal' NOT NULL,
    "created_by_user_id" uuid NOT NULL,
    "assigned_user_id" uuid,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL,
    "resolved_at" timestamp,
    "closed_at" timestamp,
    CONSTRAINT "tickets_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action,
    CONSTRAINT "tickets_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action
);

CREATE INDEX IF NOT EXISTS "tickets_created_by_idx" ON "tickets" ("created_by_user_id");
CREATE INDEX IF NOT EXISTS "tickets_assigned_idx" ON "tickets" ("assigned_user_id");
CREATE INDEX IF NOT EXISTS "tickets_status_idx" ON "tickets" ("status");
CREATE INDEX IF NOT EXISTS "tickets_updated_idx" ON "tickets" ("updated_at");
CREATE INDEX IF NOT EXISTS "tickets_number_idx" ON "tickets" ("number");

CREATE TABLE IF NOT EXISTS "ticket_comments" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "ticket_id" uuid NOT NULL,
    "author_user_id" uuid NOT NULL,
    "body" text NOT NULL,
    "is_internal" boolean DEFAULT false NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL,
    CONSTRAINT "ticket_comments_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE cascade ON UPDATE no action,
    CONSTRAINT "ticket_comments_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action
);

CREATE INDEX IF NOT EXISTS "ticket_comments_ticket_idx" ON "ticket_comments" ("ticket_id", "created_at");
