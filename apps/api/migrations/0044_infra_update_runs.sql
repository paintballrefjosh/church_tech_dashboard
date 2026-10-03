CREATE TABLE IF NOT EXISTS "infra_update_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_id" uuid NOT NULL,
	"triggered_by_user_id" uuid,
	"status" text DEFAULT 'running' NOT NULL,
	"package_manager" text,
	"reboot_requested" boolean DEFAULT false NOT NULL,
	"reboot_required" boolean,
	"reboot_triggered" boolean DEFAULT false NOT NULL,
	"exit_code" integer,
	"output" text,
	"error" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "infra_update_runs" ADD CONSTRAINT "infra_update_runs_target_id_infra_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."infra_targets"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "infra_update_runs" ADD CONSTRAINT "infra_update_runs_triggered_by_user_id_users_id_fk" FOREIGN KEY ("triggered_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "infra_update_runs_target_idx" ON "infra_update_runs" USING btree ("target_id","started_at");
