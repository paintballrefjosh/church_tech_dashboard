import { findKnownSetting } from "@church/shared";
import { HIDDEN, scrubSnapshot } from "../../audit/audit-scrub";

const present = (v: unknown) => v !== null && v !== undefined && v !== "";

/** True when a setting's value may be shown: it is in the catalogue and is not a secret. */
function showable(key: string): boolean {
  const known = findKnownSetting(key);
  return !!known && known.type !== "secret";
}

/**
 * Settings as an agent may see them. The route shows a secret in the clear to anyone who may manage the
 * category (a site admin), which is right for a person at a settings form and wrong for a model's context. A
 * secret, and any key the catalogue does not know (it may be one), has its value replaced by `[hidden]` when it
 * is set; unset stays empty so "not configured" still reads.
 */
export function hideSecretSettings(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const r = result as Record<string, unknown>;
  if (Array.isArray(r.items)) {
    return {
      ...r,
      items: r.items.map((it) => {
        const row = it as { key?: unknown; value?: unknown };
        return typeof row.key === "string" && !showable(row.key) && present(row.value) ? { ...row, value: HIDDEN } : it;
      }),
    };
  }
  if (typeof r.key === "string" && !showable(r.key) && present(r.value)) return { ...r, value: HIDDEN };
  return result;
}

/**
 * Audit rows as an agent may see them. A row keeps a snapshot of what a request carried, and not every route
 * strips its secrets from it, and rows from before the audit writer scrubbed may still hold some). Inside `before` and `after` anything
 * under a key that looks like a credential is hidden, and the value of a setting change is hidden unless the
 * setting is a known non-secret one.
 */
export function scrubAudit(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const r = result as Record<string, unknown>;
  if (!Array.isArray(r.items)) return result;
  return {
    ...r,
    items: r.items.map((it) => {
      const row = it as Record<string, unknown>;
      let before = scrubSnapshot(row.before);
      let after = scrubSnapshot(row.after);
      if (row.resourceType === "setting" && !(typeof row.resourceId === "string" && showable(row.resourceId))) {
        const hide = (s: unknown) => (s && typeof s === "object" && present((s as { value?: unknown }).value) ? { ...(s as object), value: HIDDEN } : s);
        before = hide(before);
        after = hide(after);
      }
      return { ...row, before, after };
    }),
  };
}
