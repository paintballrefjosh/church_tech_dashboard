-- Planning Center person ↔ local user link table. One-to-one in both
-- directions. Denormalised name + email so the UI stays useful even when
-- PC is unreachable.
CREATE TABLE IF NOT EXISTS "planning_center_links" (
  "user_id" uuid PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  "pc_person_id" text NOT NULL UNIQUE,
  "pc_email" text,
  "pc_first_name" text,
  "pc_last_name" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "planning_center_links_pc_person_idx"
  ON "planning_center_links" ("pc_person_id");
