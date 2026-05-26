import { SetMetadata } from "@nestjs/common";

export const AUDIT_KEY = "audit";

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
}

/** Mark a route handler as audited. The AuditInterceptor writes one row per success. */
export const Audited = (meta: AuditMeta) =>
  SetMetadata(AUDIT_KEY, { captureAfter: true, ...meta });
