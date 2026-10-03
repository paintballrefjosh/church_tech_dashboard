-- Cisco switch management (ported from the standalone cisco-switch app).
-- All child tables cascade-delete with their switch. Inline REFERENCES only
-- (CockroachDB is fine with these in CREATE TABLE; it rejects drizzle's
-- DO-block FK style, so we hand-write the migration).
CREATE TABLE IF NOT EXISTS "cisco_switches" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "hostname" text NOT NULL UNIQUE,
  "ip_address" text NOT NULL,
  "username" text NOT NULL,
  "password_enc" text,
  "model" text,
  "location" text,
  "reachable" boolean NOT NULL DEFAULT true,
  "uptime" text DEFAULT '—',
  "last_polled_at" timestamp,
  "last_error" text,
  "config_drift" boolean NOT NULL DEFAULT false,
  "check_port_state" boolean NOT NULL DEFAULT true,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cisco_switches_host_idx" ON "cisco_switches" ("hostname");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "cisco_ports" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "switch_id" uuid NOT NULL REFERENCES "cisco_switches"("id") ON DELETE CASCADE,
  "port_id" text NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "admin_enabled" boolean NOT NULL DEFAULT true,
  "speed" text NOT NULL DEFAULT '1G',
  "duplex" text NOT NULL DEFAULT 'full',
  "mode" text NOT NULL DEFAULT 'access',
  "has_switchport" boolean NOT NULL DEFAULT true,
  "access_vlan" integer NOT NULL DEFAULT 1,
  "trunk_native_vlan" integer NOT NULL DEFAULT 1,
  "trunk_allowed_vlans" text NOT NULL DEFAULT '1-4094',
  "neighbor_hostname" text,
  "neighbor_ip" text,
  "neighbor_port" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "cisco_ports_switch_port_uq" UNIQUE ("switch_id", "port_id")
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "cisco_port_live_state" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "switch_id" uuid NOT NULL REFERENCES "cisco_switches"("id") ON DELETE CASCADE,
  "port_id" text NOT NULL,
  "oper_status" text,
  "admin_enabled" boolean,
  "speed" text,
  "duplex" text,
  "mode" text,
  "access_vlan" integer,
  "trunk_native_vlan" integer,
  "trunk_allowed_vlans" text,
  "polled_at" timestamp,
  CONSTRAINT "cisco_live_switch_port_uq" UNIQUE ("switch_id", "port_id")
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "cisco_drift_events" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "switch_id" uuid NOT NULL REFERENCES "cisco_switches"("id") ON DELETE CASCADE,
  "port_id" text NOT NULL,
  "field" text NOT NULL,
  "expected" text,
  "observed" text,
  "detected_at" timestamp NOT NULL DEFAULT now(),
  "resolved_at" timestamp
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cisco_drift_open_idx" ON "cisco_drift_events" ("switch_id", "resolved_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "cisco_config_backups" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "switch_id" uuid NOT NULL REFERENCES "cisco_switches"("id") ON DELETE CASCADE,
  "config_text" text NOT NULL,
  "checksum" text NOT NULL,
  "backup_type" text NOT NULL DEFAULT 'incremental',
  "backed_up_at" timestamp NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cisco_backups_switch_idx" ON "cisco_config_backups" ("switch_id", "backed_up_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "cisco_mac_table" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "switch_id" uuid NOT NULL REFERENCES "cisco_switches"("id") ON DELETE CASCADE,
  "mac_address" text NOT NULL,
  "vlan" integer,
  "port_id" text,
  "mac_type" text DEFAULT 'dynamic',
  "polled_at" timestamp,
  CONSTRAINT "cisco_mac_uq" UNIQUE ("switch_id", "mac_address", "vlan")
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "cisco_arp_cache" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "switch_id" uuid NOT NULL REFERENCES "cisco_switches"("id") ON DELETE CASCADE,
  "ip_address" text NOT NULL,
  "mac_address" text,
  "interface" text,
  "vlan" integer,
  "vrf" text DEFAULT 'default',
  "rdns_name" text,
  "polled_at" timestamp,
  CONSTRAINT "cisco_arp_uq" UNIQUE ("switch_id", "ip_address")
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "cisco_vlan_db" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "switch_id" uuid NOT NULL REFERENCES "cisco_switches"("id") ON DELETE CASCADE,
  "vlan_id" integer NOT NULL,
  "vlan_name" text,
  "vlan_status" text DEFAULT 'active',
  "polled_at" timestamp,
  CONSTRAINT "cisco_vlan_uq" UNIQUE ("switch_id", "vlan_id")
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "cisco_neighbors" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "switch_id" uuid NOT NULL REFERENCES "cisco_switches"("id") ON DELETE CASCADE,
  "local_port" text NOT NULL,
  "neighbor_hostname" text,
  "neighbor_ip" text,
  "neighbor_port" text,
  "protocol" text,
  "neighbor_type" text DEFAULT 'switch',
  "polled_at" timestamp,
  CONSTRAINT "cisco_neighbor_uq" UNIQUE ("switch_id", "local_port", "neighbor_hostname")
);
