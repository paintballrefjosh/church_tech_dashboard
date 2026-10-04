import { pgTable, text, integer, timestamp, uuid, jsonb, index, unique } from "drizzle-orm/pg-core";
import { ipamHosts } from "./ipam";
import { users } from "./users";

/**
 * DNS sync (Monitoring → DNS). Records live in Technitium; these tables only
 * hold what the IPAM→DNS sync needs to own its records safely.
 *
 * `dns_managed_records` is the ledger of records the sync wrote, one row per
 * (zone, name, type). The Technitium-side comment `managed-by:church-dashboard`
 * is the authority on ownership (it survives a lost ledger); the ledger links a
 * record back to its IPAM host and carries its last sync state for the UI.
 *
 * `dns_sync_runs` is the audit trail for the background sync, which the HTTP
 * audit interceptor never sees: what each run added/updated/removed, and the
 * per-host outcome (`details.hosts`) the IPAM tab shows next to each host.
 */
export const dnsManagedRecords = pgTable(
  "dns_managed_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ipamHostId: uuid("ipam_host_id").references(() => ipamHosts.id, { onDelete: "set null" }),
    zone: text("zone").notNull(),
    name: text("name").notNull(), // fully qualified
    type: text("type").notNull(), // A | PTR
    value: text("value").notNull(), // IP for A, FQDN for PTR
    ttl: integer("ttl").notNull(),
    // ok | error
    state: text("state").notNull().default("ok"),
    lastError: text("last_error"),
    lastSyncedAt: timestamp("last_synced_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    uq: unique("dns_managed_records_key_uq").on(t.zone, t.name, t.type),
    hostIdx: index("dns_managed_records_host_idx").on(t.ipamHostId),
  }),
);

export const dnsSyncRuns = pgTable(
  "dns_sync_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // timer | manual | ipam-scan | ipam-edit
    trigger: text("trigger").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    finishedAt: timestamp("finished_at"),
    added: integer("added").notNull().default(0),
    updated: integer("updated").notNull().default(0),
    removed: integer("removed").notNull().default(0),
    conflicts: integer("conflicts").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    // Run-level failure or the safety-limit refusal; null on success.
    error: text("error"),
    // DnsSyncRunDetails (packages/shared/src/schemas/dns.ts).
    details: jsonb("details").notNull().default({}),
  },
  (t) => ({ startedIdx: index("dns_sync_runs_started_idx").on(t.startedAt) }),
);
