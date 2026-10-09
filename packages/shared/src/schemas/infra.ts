import { z } from "zod";

/**
 * Infrastructure monitoring — richer than the up/down `monitors` module.
 *
 * A "target" is a connection to a piece of infrastructure the worker polls
 * agentlessly (SSH for Linux hosts, the Proxmox REST API, or the Docker API
 * locally / over SSH / over TLS). Each poll writes a time-series sample plus a
 * snapshot of any discovered sub-entities (containers, VMs/CTs, cluster nodes).
 *
 * Credentials are NEVER part of the read-facing target schema — they live in a
 * separate table, are encrypted at rest, and only ever travel to the API as
 * write-only input (see `infraCredentialInputSchema`).
 */

/**
 * Legacy kind — the pre-capabilities discriminator. Still written to the DB as
 * a derived shadow column (see infra.service `deriveKind`) for backward compat,
 * but the app model is now `os` + `capabilities`. Don't branch on this in new
 * code; use capabilities.
 */
export const INFRA_KINDS = ["linux_ssh", "proxmox", "docker_host"] as const;
export type InfraKind = (typeof INFRA_KINDS)[number];

/** Target operating system — the primary axis for a target. */
export const INFRA_OS = ["linux", "mac", "windows"] as const;
export type InfraOs = (typeof INFRA_OS)[number];

/**
 * Toggleable monitoring capabilities. Each enables specific collection; the
 * transport is derived from the set — `hypervisor` uses the Proxmox API (its
 * own token), everything else rides one SSH login (OpenSSH + PowerShell on
 * Windows). `docker` composes over that same SSH connection.
 */
export const INFRA_CAPABILITIES = [
  "cpu",
  "memory",
  "disk",
  "load",
  "docker",
  "hypervisor",
  "updates",
  "services",
] as const;
export type InfraCapability = (typeof INFRA_CAPABILITIES)[number];

export interface InfraCapabilityDef {
  key: InfraCapability;
  label: string;
  description: string;
  /** Which operating systems offer this capability. */
  os: readonly InfraOs[];
  /** True when this capability's data comes from the Proxmox API, not SSH. */
  usesHypervisorApi?: boolean;
}

export const INFRA_CAPABILITY_DEFS: readonly InfraCapabilityDef[] = [
  { key: "cpu", label: "CPU", description: "Processor utilisation.", os: ["linux", "mac", "windows"] },
  { key: "memory", label: "Memory", description: "RAM usage.", os: ["linux", "mac", "windows"] },
  { key: "disk", label: "Disk", description: "Filesystem usage.", os: ["linux", "mac", "windows"] },
  { key: "load", label: "Load average", description: "Run-queue load (Unix-like hosts).", os: ["linux", "mac"] },
  {
    key: "docker",
    label: "Docker host",
    description: "Container inventory + health, collected over the same SSH login.",
    os: ["linux", "mac"],
  },
  {
    key: "hypervisor",
    label: "Hypervisor host (Proxmox)",
    description: "VMs/containers and node stats via the Proxmox API. Uses an API token instead of SSH.",
    os: ["linux"],
    usesHypervisorApi: true,
  },
  {
    key: "updates",
    label: "OS updates",
    description:
      "Pending package updates + reboot-required, over the same SSH login. Opt-in (unlike cpu/memory/disk/load) " +
      "because the check itself varies in cost: Linux just reads the package manager's own local cache (free), " +
      "but macOS/Windows hit their update service live on every poll.",
    os: ["linux", "mac", "windows"],
  },
  {
    key: "services",
    label: "Watched services",
    description:
      "Status of specific systemd units (Linux) or services (Windows) you name, over the same SSH login. " +
      "Add the service names to watch from the target's detail page. Not offered on macOS — launchd's model " +
      "doesn't map cleanly onto the same active/inactive check.",
    os: ["linux", "windows"],
  },
];

/** Capabilities selectable for a given OS, in catalogue order. */
export function infraCapabilitiesForOs(os: InfraOs): InfraCapabilityDef[] {
  return INFRA_CAPABILITY_DEFS.filter((c) => c.os.includes(os));
}

export function findInfraCapability(key: string): InfraCapabilityDef | undefined {
  return INFRA_CAPABILITY_DEFS.find((c) => c.key === key);
}

/** The Proxmox-API transport is used iff the `hypervisor` capability is on. */
export function usesHypervisorTransport(capabilities: readonly string[]): boolean {
  return capabilities.includes("hypervisor");
}

export const INFRA_STATUSES = ["up", "down", "degraded", "unknown"] as const;
export type InfraStatus = (typeof INFRA_STATUSES)[number];

/** How the worker reaches the Docker daemon for a `docker_host` target. */
export const DOCKER_TRANSPORTS = ["local", "ssh", "tls"] as const;
export type DockerTransport = (typeof DOCKER_TRANSPORTS)[number];

/** Discovered sub-entity kinds stored in `infra_entities` / `infra_metric_samples`. */
export const INFRA_ENTITY_KINDS = ["target", "container", "guest", "node", "storage"] as const;
export type InfraEntityKind = (typeof INFRA_ENTITY_KINDS)[number];

/** Credential shapes; drives which secret fields the collector expects. */
export const INFRA_AUTH_TYPES = ["ssh_key", "ssh_password", "proxmox_token", "docker_tls"] as const;
export type InfraAuthType = (typeof INFRA_AUTH_TYPES)[number];

/**
 * Per-kind connection options live in one freeform `options` blob so adding a
 * dimension doesn't need a migration. Documented here for the collector + UI;
 * the target schema stores it loosely as a record.
 */
export const infraOptionsSchema = z.object({
  /** SSH / Docker-TLS / Proxmox port. Defaults applied by the collector per kind. */
  port: z.number().int().min(1).max(65_535).optional(),
  /** docker_host only: how to reach the daemon. */
  dockerTransport: z.enum(DOCKER_TRANSPORTS).optional(),
  /** Accept self-signed TLS (Proxmox / Docker-TLS). */
  allowSelfSigned: z.boolean().optional(),
  /** Proxmox: restrict polling to these node names (empty = all cluster nodes). */
  proxmoxNodes: z.array(z.string()).optional(),
  /** SSH timeout in ms for a single poll's command batch. */
  timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
  /**
   * Filesystem mount paths excluded from `diskPctMax` (and therefore from the
   * `diskPctMax` threshold metric and the target-level disk gauge/history) —
   * e.g. a UDM Pro's boot/log partitions that run near-100% by design. The
   * mount still appears in `metrics.filesystems` (flagged `ignored: true`) so
   * the UI can keep showing it and let the toggle be switched back off.
   */
  ignoredMounts: z.array(z.string()).optional(),
  /**
   * Service names watched by the `services` capability — systemd unit names on
   * Linux, service names (`Get-Service -Name`) on Windows. Each poll reports
   * every entry's active/inactive state into `metrics.services`.
   */
  watchedServices: z.array(z.string()).optional(),
});
export type InfraOptions = z.infer<typeof infraOptionsSchema>;

/**
 * A threshold alert rule. Evaluated by the worker against the promoted headline
 * scalars or a JSONB metric path; a sustained breach opens a `monitor_incident`.
 */
export const infraThresholdRuleSchema = z.object({
  id: z.string().min(1).max(64),
  /** Which entity the rule applies to. `target` = the host/node itself. */
  entityKind: z.enum(INFRA_ENTITY_KINDS).default("target"),
  /**
   * Metric selector: a promoted scalar (`cpuPct`, `memPct`, `diskPctMax`) or a
   * path into the metrics blob (e.g. `fs./var:pct`, `container:health`).
   */
  metricPath: z.string().min(1).max(200),
  op: z.enum([">", ">=", "<", "<=", "=="]),
  value: z.number(),
  /** Sustained duration before the alert fires (debounces flapping). */
  forSec: z.number().int().min(0).max(86_400).default(60),
  severity: z.enum(["info", "warning", "critical"]).default("warning"),
});
export type InfraThresholdRule = z.infer<typeof infraThresholdRuleSchema>;

/**
 * Catalogue of target-level metrics an alert rule can watch, with human labels
 * so the threshold editor can offer a dropdown instead of a raw metric-path
 * text box. `path` is exactly what the collector's `resolveMetric` understands
 * (a promoted scalar or a dotted path into the metrics blob). `kinds` gates
 * which targets expose the metric — e.g. a Docker host only surfaces aggregate
 * CPU at the target level, so memory/disk aren't offered there.
 *
 * This constrains the UI only; `metricPath` stays a free string on the wire so
 * existing rules and advanced dotted paths keep working.
 */
export interface InfraMetricDef {
  path: string;
  label: string;
  /** Suffix shown next to the threshold value input; "" for unitless. */
  unit: string;
  description: string;
  /** The capability that must be enabled for this metric to be collected. */
  capability: InfraCapability;
  /** Sensible starting point when the operator adds this metric. */
  suggestedOp: ">" | ">=" | "<" | "<=";
  suggestedValue: number;
}

export const INFRA_TARGET_METRICS: readonly InfraMetricDef[] = [
  {
    path: "cpuPct",
    label: "CPU usage",
    unit: "%",
    description: "Overall processor utilisation across the host.",
    capability: "cpu",
    suggestedOp: ">",
    suggestedValue: 90,
  },
  {
    path: "memPct",
    label: "Memory usage",
    unit: "%",
    description: "RAM in use (excludes reclaimable cache).",
    capability: "memory",
    suggestedOp: ">",
    suggestedValue: 90,
  },
  {
    path: "diskPctMax",
    label: "Disk usage (busiest filesystem)",
    unit: "%",
    description: "Highest usage across all mounted filesystems.",
    capability: "disk",
    suggestedOp: ">",
    suggestedValue: 85,
  },
  {
    path: "load.one",
    label: "Load average (1 min)",
    unit: "",
    description: "Run-queue load over the last minute. Compare against core count.",
    capability: "load",
    suggestedOp: ">",
    suggestedValue: 4,
  },
  {
    path: "load.five",
    label: "Load average (5 min)",
    unit: "",
    description: "Run-queue load over the last five minutes.",
    capability: "load",
    suggestedOp: ">",
    suggestedValue: 4,
  },
  {
    path: "load.fifteen",
    label: "Load average (15 min)",
    unit: "",
    description: "Run-queue load over the last fifteen minutes.",
    capability: "load",
    suggestedOp: ">",
    suggestedValue: 4,
  },
  {
    path: "updates.count",
    label: "Package updates available",
    unit: "",
    description: "Pending OS package updates last seen by the collector.",
    capability: "updates",
    suggestedOp: ">",
    suggestedValue: 0,
  },
  {
    path: "updates.securityCount",
    label: "Security updates available",
    unit: "",
    description: "Of the pending updates, how many the package manager flags security/critical.",
    capability: "updates",
    suggestedOp: ">",
    suggestedValue: 0,
  },
  {
    path: "updates.rebootRequired",
    label: "Reboot required",
    unit: "",
    description: "1 when the host itself is flagging a pending reboot (e.g. after a kernel update).",
    capability: "updates",
    suggestedOp: ">=",
    suggestedValue: 1,
  },
  {
    path: "servicesDownCount",
    label: "Watched services not running",
    unit: "",
    description: "Of the services named in options.watchedServices, how many aren't active/running.",
    capability: "services",
    suggestedOp: ">",
    suggestedValue: 0,
  },
];

/**
 * Metrics selectable given a target's enabled capabilities, in catalogue order.
 * A metric only appears once its capability is toggled on.
 */
export function infraMetricsForCapabilities(capabilities: readonly string[]): InfraMetricDef[] {
  return INFRA_TARGET_METRICS.filter((m) => capabilities.includes(m.capability));
}

/** Look up a metric definition by its `path`, or undefined for custom paths. */
export function findInfraMetric(path: string): InfraMetricDef | undefined {
  return INFRA_TARGET_METRICS.find((m) => m.path === path);
}

/** One service found by an on-demand discovery probe against a target's host. */
export const infraDiscoveredServiceSchema = z.object({
  name: z.string(),
  active: z.boolean(),
  status: z.string(),
});
export type InfraDiscoveredService = z.infer<typeof infraDiscoveredServiceSchema>;

/** Read-facing target (no secrets, ever). */
export const infraTargetSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(200),
  os: z.enum(INFRA_OS),
  capabilities: z.array(z.enum(INFRA_CAPABILITIES)),
  host: z.string().min(1).max(255),
  enabled: z.boolean(),
  intervalSec: z.number().int().min(10).max(86_400),
  options: z.record(z.unknown()),
  thresholds: z.array(infraThresholdRuleSchema),
  status: z.enum(INFRA_STATUSES),
  lastPolledAt: z.string().datetime().nullable(),
  lastError: z.string().nullable(),
  lastSample: z.record(z.unknown()).nullable(),
  /** Whether a credential row exists (so the UI can show "configured" without leaking it). */
  hasCredential: z.boolean(),
  /** Auth type of the stored credential, if any (not the secret itself). */
  authType: z.enum(INFRA_AUTH_TYPES).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type InfraTarget = z.infer<typeof infraTargetSchema>;

/**
 * Write-only credential input. Blank/omitted secret on update = leave unchanged
 * (mirrors the settings `secret` convention). The API encrypts before storage.
 */
export const infraCredentialInputSchema = z.object({
  authType: z.enum(INFRA_AUTH_TYPES),
  /** SSH username / Proxmox `user@realm!tokenid`. */
  username: z.string().max(255).optional(),
  /** Private key / password / Proxmox token secret / Docker-TLS client cert. */
  secret: z.string().max(20_000).optional(),
  /** SSH key passphrase / Docker-TLS client key. */
  extra: z.string().max(20_000).optional(),
  /** Pinned CA / TLS server cert (not a secret). */
  caCert: z.string().max(20_000).optional(),
});
export type InfraCredentialInput = z.infer<typeof infraCredentialInputSchema>;

export const createInfraTargetSchema = z.object({
  name: z.string().min(1).max(200),
  os: z.enum(INFRA_OS),
  capabilities: z.array(z.enum(INFRA_CAPABILITIES)).default([]),
  host: z.string().min(1).max(255),
  enabled: z.boolean().default(true),
  intervalSec: z.number().int().min(10).max(86_400).default(30),
  options: z.record(z.unknown()).default({}),
  thresholds: z.array(infraThresholdRuleSchema).default([]),
  credential: infraCredentialInputSchema.optional(),
});
export type CreateInfraTargetInput = z.infer<typeof createInfraTargetSchema>;

export const updateInfraTargetSchema = createInfraTargetSchema.partial();
export type UpdateInfraTargetInput = z.infer<typeof updateInfraTargetSchema>;

/** A discovered sub-entity (container / VM / CT / node / storage pool). */
export const infraEntitySchema = z.object({
  id: z.string().uuid(),
  targetId: z.string().uuid(),
  entityKind: z.enum(INFRA_ENTITY_KINDS),
  externalId: z.string(),
  name: z.string(),
  groupKey: z.string().nullable(),
  status: z.string(),
  health: z.string().nullable(),
  state: z.record(z.unknown()),
  present: z.boolean(),
  firstSeenAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
});
export type InfraEntity = z.infer<typeof infraEntitySchema>;

/** One time-series point returned by the metrics endpoint (raw or rolled-up). */
export const infraMetricPointSchema = z.object({
  ts: z.string().datetime(),
  cpuPct: z.number().nullable(),
  memPct: z.number().nullable(),
  diskPctMax: z.number().nullable(),
  metrics: z.record(z.unknown()),
});
export type InfraMetricPoint = z.infer<typeof infraMetricPointSchema>;

export const infraSeriesResponseSchema = z.object({
  targetId: z.string().uuid(),
  entityKind: z.enum(INFRA_ENTITY_KINDS),
  entityId: z.string(),
  /** Which store the points came from, so the UI can label resolution. */
  resolution: z.enum(["raw", "5m", "1h"]),
  from: z.string().datetime(),
  to: z.string().datetime(),
  points: z.array(infraMetricPointSchema),
});
export type InfraSeriesResponse = z.infer<typeof infraSeriesResponseSchema>;

/** Fleet-wide rollup for the overview page. */
export const infraSummarySchema = z.object({
  targets: z.object({
    total: z.number().int(),
    up: z.number().int(),
    down: z.number().int(),
    degraded: z.number().int(),
    unknown: z.number().int(),
    /** Targets switched off. Not counted in `total` or the status counts: they are not being polled. */
    disabled: z.number().int().optional(),
  }),
  containers: z.object({
    total: z.number().int(),
    running: z.number().int(),
    stopped: z.number().int(),
    unhealthy: z.number().int(),
  }),
  guests: z.object({
    total: z.number().int(),
    running: z.number().int(),
    stopped: z.number().int(),
  }),
  openAlerts: z.number().int(),
  /** Fleet-wide OS-updates rollup, from the `updates` capability's last sample. */
  updates: z.object({
    hostsWithUpdates: z.number().int(),
    hostsWithSecurityUpdates: z.number().int(),
    hostsNeedingReboot: z.number().int(),
  }),
});
export type InfraSummary = z.infer<typeof infraSummarySchema>;

/**
 * OS-updates capability is Linux-only for the "run it now" mutation (unlike
 * the read-only check, which also covers mac/windows — see infra-updater.ts
 * for why: an unattended write path needs a real host to validate against,
 * and this church's fleet is Linux).
 */
export const INFRA_UPDATE_RUN_STATUSES = [
  "running",
  "success",
  "failed",
  "timed_out",
  // The login needs a sudo password the dashboard does not have (or was given a wrong one). Nothing ran; the UI asks.
  "needs_sudo",
  // sudo refused the login outright (not in sudoers / not allowed to run sudo). Needs fixing on the host.
  "sudo_denied",
] as const;
export type InfraUpdateRunStatus = (typeof INFRA_UPDATE_RUN_STATUSES)[number];

export const infraUpdateRunSchema = z.object({
  id: z.string().uuid(),
  targetId: z.string().uuid(),
  triggeredByUserId: z.string().uuid().nullable(),
  triggeredByName: z.string().nullable(),
  status: z.enum(INFRA_UPDATE_RUN_STATUSES),
  packageManager: z.string().nullable(),
  fullUpgrade: z.boolean(),
  includePhased: z.boolean(),
  rebootRequested: z.boolean(),
  rebootRequired: z.boolean().nullable(),
  rebootTriggered: z.boolean(),
  exitCode: z.number().int().nullable(),
  output: z.string().nullable(),
  error: z.string().nullable(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
});
export type InfraUpdateRun = z.infer<typeof infraUpdateRunSchema>;

export const createInfraUpdateRunSchema = z.object({
  /** Reboot once the upgrade finishes, but only if it's actually needed. */
  reboot: z.boolean().default(false),
  /**
   * apt-only: use `full-upgrade` instead of plain `upgrade`. Plain upgrade
   * never removes/replaces a package, so a kernel/dependency-driven bump
   * shows as "kept back" forever unless this is on. Off by default — full
   * upgrade can add or remove packages as a side effect of resolving
   * dependencies, which is more than the default conservative mode does.
   */
  fullUpgrade: z.boolean().default(false),
  /**
   * apt-only: pass `-o APT::Get::Always-Include-Phased-Updates=true` so a
   * package still in Canonical's staged rollout window gets installed
   * anyway, instead of apt correctly deferring it until its phase-in
   * reaches this machine. Off by default — phasing exists as a real
   * regression safety net; this is explicitly opting out of it.
   */
  includePhased: z.boolean().default(false),
  /**
   * The login's sudo password, supplied for this run only after a run stopped with `needs_sudo`. Never stored
   * or audited; sent to the host over the SSH channel's stdin.
   */
  sudoPassword: z.string().min(1).max(512).optional(),
  /**
   * With `sudoPassword`: first write a sudoers drop-in giving this login passwordless sudo on the host, then
   * run the update. The only thing that persists after the password is forgotten.
   */
  enablePasswordlessSudo: z.boolean().default(false),
}).refine((v) => !v.enablePasswordlessSudo || Boolean(v.sudoPassword), {
  message: "A sudo password is required to enable passwordless sudo",
  path: ["sudoPassword"],
});
export type CreateInfraUpdateRunInput = z.infer<typeof createInfraUpdateRunSchema>;
