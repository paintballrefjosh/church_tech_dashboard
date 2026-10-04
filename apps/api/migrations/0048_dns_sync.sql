-- DNS sync (Monitoring -> DNS, phase 3): per-subnet opt-in, per-host name
-- override, the ledger of records the IPAM->DNS sync wrote, and its run log.
-- FKs are bare ALTERs (no DO-blocks) because CockroachDB v24.2 rejects
-- anonymous PL/pgSQL. No backfill: every new column has a default or is null.
ALTER TABLE "ipam_subnets" ADD COLUMN "dns_sync" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ipam_hosts" ADD COLUMN "dns_name" text;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dns_managed_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ipam_host_id" uuid,
	"zone" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"value" text NOT NULL,
	"ttl" integer NOT NULL,
	"state" text DEFAULT 'ok' NOT NULL,
	"last_error" text,
	"last_synced_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "dns_managed_records_key_uq" UNIQUE("zone","name","type")
);
--> statement-breakpoint
ALTER TABLE "dns_managed_records" ADD CONSTRAINT "dns_managed_records_ipam_host_id_ipam_hosts_id_fk" FOREIGN KEY ("ipam_host_id") REFERENCES "ipam_hosts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dns_managed_records_host_idx" ON "dns_managed_records" USING btree ("ipam_host_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dns_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trigger" text NOT NULL,
	"actor_user_id" uuid,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp,
	"added" integer DEFAULT 0 NOT NULL,
	"updated" integer DEFAULT 0 NOT NULL,
	"removed" integer DEFAULT 0 NOT NULL,
	"conflicts" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"error" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dns_sync_runs" ADD CONSTRAINT "dns_sync_runs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dns_sync_runs_started_idx" ON "dns_sync_runs" USING btree ("started_at");
