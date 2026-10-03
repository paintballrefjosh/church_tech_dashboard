import type { InfraOptions, InfraEntityKind } from "@church/shared";

/** Decrypted credential handed to a collector (never persisted in this shape). */
export interface DecryptedCredential {
  authType: string;
  username: string | null;
  secret: string | null;
  extra: string | null;
  caCert: string | null;
}

/** Everything a collector needs to reach one target for one poll. */
export interface CollectContext {
  targetId: string;
  host: string;
  options: InfraOptions;
  credential: DecryptedCredential | null;
  knownHostKey: string | null;
  /**
   * Previous poll's raw counters for this target, so a collector can turn
   * cumulative kernel counters (net bytes, disk sectors) into per-second rates.
   * Opaque to the orchestrator; each collector owns its own shape.
   */
  prev: Record<string, unknown> | null;
}

/** A discovered sub-entity (container / guest / node / storage). */
export interface CollectedEntity {
  entityKind: Exclude<InfraEntityKind, "target">;
  externalId: string;
  name: string;
  groupKey?: string | null;
  status: string;
  health?: string | null;
  state: Record<string, unknown>;
  /** Optional time-series sample for this entity (charts). */
  sample?: {
    cpuPct: number | null;
    memPct: number | null;
    diskPctMax: number | null;
    metrics: Record<string, unknown>;
  };
}

/** The result of one collection poll. */
export interface CollectResult {
  ok: boolean;
  error?: string;
  /**
   * Set on an `ok` result that connected but is not collecting what it should
   * (e.g. an API token without audit rights). Marks the target "degraded" and
   * is surfaced as its lastError.
   */
  warning?: string;
  /** SSH host-key fingerprint discovered this connect (for TOFU pinning). */
  hostKey?: string | null;
  /** Target-level headline + detailed metrics. */
  target: {
    cpuPct: number | null;
    memPct: number | null;
    diskPctMax: number | null;
    metrics: Record<string, unknown>;
  };
  entities: CollectedEntity[];
  /** Carried into the next poll's `ctx.prev` for rate computation. */
  prev?: Record<string, unknown>;
}

/** Whether this mount is excluded from `diskPctMax` per the target's `options.ignoredMounts`. */
export function isIgnoredMount(ctx: CollectContext, mount: string): boolean {
  return (ctx.options.ignoredMounts ?? []).includes(mount);
}

export function emptyResult(error: string): CollectResult {
  return {
    ok: false,
    error,
    target: { cpuPct: null, memPct: null, diskPctMax: null, metrics: {} },
    entities: [],
  };
}
