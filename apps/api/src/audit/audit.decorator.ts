import { SetMetadata } from "@nestjs/common";

export const AUDIT_KEY = "audit";
export const SKIP_AUDIT_KEY = "audit:skip";

export interface AuditMeta {
  /** Dot-separated action key, e.g. "user.create", "role.update". */
  action: string;
  /** Resource type, e.g. "user", "role", "group". */
  resourceType: string;
  /** If the response is the resource, capture it as the "after" snapshot. Defaults true. */
  captureAfter?: boolean;
  /** Capture a "before" snapshot. Phase 0 leaves this to the controller layer. */
  captureBefore?: boolean;
  /** Extract a resource id from route params if the response doesn't carry one. */
  resourceIdFromParams?: (params: Record<string, string>) => string | null;
  /** Top-level keys dropped from the snapshot before it's stored (secrets in a response, e.g. a new API token). */
  redactKeys?: readonly string[];
}

/**
 * Mark a route handler as audited with explicit action/resource names. The
 * interceptor uses this where present; mutating routes without an @Audited
 * decorator still get a row, derived from the HTTP method + path (so nothing
 * silently goes unaudited).
 */
export const Audited = (meta: AuditMeta) =>
  SetMetadata(AUDIT_KEY, { captureAfter: true, ...meta });

/** Request property holding entries recorded by recordAuditEntry(). */
export const AUDIT_ENTRIES_KEY = "auditEntries";

/** One audit row a handler decided on at runtime (see recordAuditEntry). */
export interface DynamicAuditEntry {
  action: string;
  resourceType: string;
  resourceId?: string | null;
  after?: unknown;
}

/**
 * For handlers whose audit action depends on what the request turned out to
 * do (the MCP endpoint multiplexes reads and writes over one POST). Call
 * `startDynamicAudit(req)` first: from then on the interceptor writes exactly
 * the recorded entries instead of the route-level row, so a request that only
 * read something writes none. The interceptor stays the only audit writer.
 */
export function startDynamicAudit(req: object): void {
  (req as { [AUDIT_ENTRIES_KEY]?: DynamicAuditEntry[] })[AUDIT_ENTRIES_KEY] = [];
}

export function recordAuditEntry(req: object, entry: DynamicAuditEntry): void {
  const r = req as { [AUDIT_ENTRIES_KEY]?: DynamicAuditEntry[] };
  (r[AUDIT_ENTRIES_KEY] ??= []).push(entry);
}

/**
 * Opt a mutating route OUT of auditing. Reserve for high-volume reads-pretending-
 * to-be-writes (notification mark-read), liveness pings, and anything else where
 * the audit row would be pure noise. Adds up — review uses sparingly.
 */
export const SkipAudit = () => SetMetadata(SKIP_AUDIT_KEY, true);
