import {
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
  boolean,
  jsonb,
  real,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * Infrastructure monitoring target — a connection the `monitor` worker polls
 * agentlessly (SSH for Linux hosts, the Proxmox REST API, or the Docker API
 * locally / over SSH / over TLS). Distinct from the `monitors` table (simple
 * up/down probes): infra targets carry encrypted credentials, emit rich
 * time-series metrics, and discover variable-cardinality sub-entities
 * (containers, VMs/CTs, cluster nodes).
 *
 * Per-kind connection options + threshold rules live in freeform JSONB blobs so
 * the catalogue grows without DDL. The worker is the only writer of the
 * denormalised "current state" columns (status/lastPolledAt/lastSample), which
 * let the list + overview render without touching the high-volume samples table.
 */
export const infraTargets = pgTable(
  "infra_targets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    // Legacy discriminator, kept as a derived shadow (see infra.service
    // deriveKind). The live model is os + capabilities below.
    kind: text("kind").notNull(), // "linux_ssh" | "proxmox" | "docker_host"
    os: text("os").notNull().default("linux"), // "linux" | "mac" | "windows"
    capabilities: text("capabilities").array().notNull().default([]), // InfraCapability[]
    host: text("host").notNull(), // ip / hostname; "local" for the local docker socket
    enabled: boolean("enabled").notNull().default(true),
    intervalSec: integer("interval_sec").notNull().default(30),
    options: jsonb("options").notNull().default({}), // port, dockerTransport, allowSelfSigned, proxmoxNodes, timeoutMs
    thresholds: jsonb("thresholds").notNull().default([]), // InfraThresholdRule[]
    knownHostKey: text("known_host_key"), // SSH TOFU fingerprint, pinned on first connect

    // Denormalised current state (worker is the only writer).
    status: text("status").notNull().default("unknown"), // "up" | "down" | "degraded" | "unknown"
    lastPolledAt: timestamp("last_polled_at"),
    lastError: text("last_error"),
    lastSample: jsonb("last_sample"), // most recent target-level sample for instant list render
    alertState: jsonb("alert_state").notNull().default({}), // ruleId -> { breachingSince, open, incidentId }

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    enabledIdx: index("infra_targets_enabled_idx").on(t.enabled),
  }),
);

/**
 * Per-target credentials, split from the target row so secrets are never
 * selected into list/detail queries by accident. All secret-bearing columns are
 * AES-256-GCM encrypted at rest (`enc:v1:` wire format), reusing the same
 * primitive as the settings table. Write-only over the API.
 */
export const infraTargetCredentials = pgTable("infra_target_credentials", {
  targetId: uuid("target_id")
    .primaryKey()
    .references(() => infraTargets.id, { onDelete: "cascade" }),
  authType: text("auth_type").notNull(), // "ssh_key" | "ssh_password" | "proxmox_token" | "docker_tls"
  username: text("username"), // ssh user / proxmox "user@realm!tokenid"
  secretEnc: text("secret_enc"), // private key / password / token secret / TLS client cert (encrypted)
  extraEnc: text("extra_enc"), // key passphrase / TLS client key (encrypted)
  caCert: text("ca_cert"), // pinned CA / TLS server cert (not secret)
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * Time-series metrics — WIDE JSONB-per-sample (one row per (target, entity,
 * tick)), NOT narrow key/value. At fleet scale a fully-narrow table would be
 * millions of rows/day with heavy index bloat; wide is ~1 row/host/tick and
 * matches the chart query pattern of "one entity's window".
 *
 * Headline scalars (cpu/mem/diskPctMax) are promoted to columns for the
 * overview + threshold eval without parsing JSONB. Per-core / per-fs / per-iface
 * / per-disk-IO facets stay nested in `metrics`. Independently-countable
 * sub-entities (containers, guests, nodes) get their own rows.
 *
 * PK is targetId-prefixed to spread writes across ranges/tablets (a
 * leading-timestamp PK would create a single hot range on CockroachDB and
 * YugabyteDB alike). Raw rows older than 7 days are pruned by
 * InfraCollector.prune(), the same on every engine.
 */
export const infraMetricSamples = pgTable(
  "infra_metric_samples",
  {
    targetId: uuid("target_id")
      .notNull()
      .references(() => infraTargets.id, { onDelete: "cascade" }),
    entityKind: text("entity_kind").notNull(), // "target" | "container" | "guest" | "node"
    entityId: text("entity_id").notNull().default(""), // "" for target-level
    ts: timestamp("ts").notNull().defaultNow(),
    cpuPct: real("cpu_pct"),
    memPct: real("mem_pct"),
    diskPctMax: real("disk_pct_max"), // worst filesystem / storage pool
    metrics: jsonb("metrics").notNull().default({}),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.targetId, t.entityKind, t.entityId, t.ts] }),
    tsIdx: index("infra_metric_samples_ts_idx").on(t.ts),
  }),
);

/**
 * Downsampled rollups built from raw samples by the worker. Range-aware series
 * queries read the coarsest store that satisfies the requested window
 * (raw <=24h, 5m <=~14d, else 1h). Retained longer than raw (5m 90 days, 1h
 * 365 days), also pruned by InfraCollector.prune().
 */
export const infraMetricRollups = pgTable(
  "infra_metric_rollups",
  {
    targetId: uuid("target_id")
      .notNull()
      .references(() => infraTargets.id, { onDelete: "cascade" }),
    entityKind: text("entity_kind").notNull(),
    entityId: text("entity_id").notNull().default(""),
    bucket: text("bucket").notNull(), // "5m" | "1h"
    ts: timestamp("ts").notNull(), // bucket start
    metrics: jsonb("metrics").notNull().default({}), // { metric: { min, avg, max } }
    samples: integer("samples").notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.targetId, t.entityKind, t.entityId, t.bucket, t.ts] }),
    tsIdx: index("infra_metric_rollups_ts_idx").on(t.ts),
  }),
);

/**
 * Current-state snapshot of discovered sub-entities (docker containers, Proxmox
 * guests/nodes/storage). One generalized table minimizes the schema-mirror
 * burden in the worker. Upserted per poll on (targetId, entityKind, externalId);
 * entities not seen in a poll are marked present=false so a removed container
 * lingers visibly rather than vanishing.
 */
export const infraEntities = pgTable(
  "infra_entities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    targetId: uuid("target_id")
      .notNull()
      .references(() => infraTargets.id, { onDelete: "cascade" }),
    entityKind: text("entity_kind").notNull(), // "container" | "guest" | "node" | "storage"
    externalId: text("external_id").notNull(), // containerId / vmid / nodename / storageid
    name: text("name").notNull(),
    groupKey: text("group_key"), // composeProject (docker) | cluster/node (proxmox)
    status: text("status").notNull(),
    health: text("health"), // healthy/unhealthy/starting (docker)
    state: jsonb("state").notNull().default({}), // image, restartCount, uptime, cpu/mem/net snapshot
    present: boolean("present").notNull().default(true),
    firstSeenAt: timestamp("first_seen_at").notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
  },
  (t) => ({
    targetIdx: index("infra_entities_target_idx").on(t.targetId, t.entityKind),
    externalUnique: uniqueIndex("infra_entities_external_unique").on(
      t.targetId,
      t.entityKind,
      t.externalId,
    ),
  }),
);

/**
 * One row per "run updates now" click from the target detail page — a
 * SSH-triggered package-manager upgrade, optionally followed by a reboot iff
 * one turns out to still be needed once the upgrade finishes. Linux-only for
 * now (see infra-updater.ts); rows are the audit trail + what the detail page
 * polls for progress, on top of the mandatory audit_log row from @Audited.
 */
export const infraUpdateRuns = pgTable(
  "infra_update_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    targetId: uuid("target_id")
      .notNull()
      .references(() => infraTargets.id, { onDelete: "cascade" }),
    triggeredByUserId: uuid("triggered_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull().default("running"), // "running" | "success" | "failed" | "timed_out"
    packageManager: text("package_manager"), // detected at run time, e.g. "apt"
    // apt-only distinction (see infra-updater.ts upgradeScript): plain `upgrade`
    // never removes/replaces a package, so a kernel bump that changes
    // dependencies shows as "kept back" forever unless this is on. Other
    // package managers' upgrade command already resolves this either way, so
    // the flag is a no-op for them.
    fullUpgrade: boolean("full_upgrade").notNull().default(false), // the operator's checkbox
    // apt-only: Ubuntu/Debian stage certain package versions out to a
    // percentage of machines at a time (a phased rollout, hashed per
    // machine-id) to catch regressions before wider exposure. apt-get
    // upgrade correctly defers a package still in its phase-in window; this
    // is the operator explicitly asking to bypass that and take it anyway.
    includePhased: boolean("include_phased").notNull().default(false), // the operator's checkbox
    rebootRequested: boolean("reboot_requested").notNull().default(false), // the operator's checkbox
    rebootRequired: boolean("reboot_required"), // re-checked AFTER the upgrade completes
    rebootTriggered: boolean("reboot_triggered").notNull().default(false),
    exitCode: integer("exit_code"),
    output: text("output"), // combined stdout+stderr, truncated (see MAX_OUTPUT_CHARS)
    error: text("error"), // set on failure/timeout; distinct from a non-zero exitCode
    startedAt: timestamp("started_at").notNull().defaultNow(),
    finishedAt: timestamp("finished_at"),
  },
  (t) => ({
    targetIdx: index("infra_update_runs_target_idx").on(t.targetId, t.startedAt),
  }),
);
