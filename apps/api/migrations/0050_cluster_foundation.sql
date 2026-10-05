CREATE TABLE IF NOT EXISTS "cluster_leases" (
	"name" text PRIMARY KEY NOT NULL,
	"holder" text NOT NULL,
	"epoch" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cluster_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"instance_id" text NOT NULL,
	"role" text DEFAULT 'full' NOT NULL,
	"addr" text,
	"version" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_state" (
	"job" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_state_job_key_pk" PRIMARY KEY("job","key")
);
--> statement-breakpoint
ALTER TABLE "infra_update_runs" ADD COLUMN IF NOT EXISTS "node_id" text;
