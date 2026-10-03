-- IPAM — managed subnets + discovered hosts for the Monitoring → IPAM tab.
-- `ipam_subnets` holds CIDR ranges (added manually or discovered from Cisco
-- config/ARP + UniFi networkconf); the background scanner sweeps every
-- scan-enabled row and records live hosts in `ipam_hosts`. Inline REFERENCES
-- (no DO block) for CockroachDB v24.2 compatibility.
CREATE TABLE IF NOT EXISTS "ipam_subnets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cidr" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"vlan_id" integer,
	"gateway" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"source_detail" text,
	"scan_enabled" boolean DEFAULT true NOT NULL,
	"last_scan_started_at" timestamp,
	"last_scan_finished_at" timestamp,
	"last_error" text,
	"host_count" integer DEFAULT 0 NOT NULL,
	"alive_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ipam_subnets_cidr_unique" UNIQUE("cidr")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ipam_hosts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subnet_id" uuid NOT NULL REFERENCES "ipam_subnets"("id") ON DELETE cascade,
	"ip_address" text NOT NULL,
	"mac_address" text,
	"hostname" text,
	"netbios_name" text,
	"bonjour_name" text,
	"is_up" boolean DEFAULT false NOT NULL,
	"responded_via" text,
	"open_ports" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp,
	"last_scan_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ipam_hosts_subnet_ip_uq" UNIQUE("subnet_id","ip_address")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ipam_subnets_cidr_idx" ON "ipam_subnets" USING btree ("cidr");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ipam_hosts_ip_idx" ON "ipam_hosts" USING btree ("ip_address");
