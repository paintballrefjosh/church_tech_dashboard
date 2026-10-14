import { findKnownSetting } from "@church/shared";
import { HIDDEN } from "./api-bridge.service";

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

const SECRET_KEY = /pass(word)?|secret|token|authorization|community|private.?key|api.?key|credential|cookie/i;

function scrubDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) && present(v) && typeof v !== "boolean" ? HIDDEN : scrubDeep(v);
    }
    return out;
  }
  return value;
}

/**
 * Audit rows as an agent may see them. A row keeps a snapshot of what a request carried, and not every route
 * strips its secrets from it (a settings change stores the new value). Inside `before` and `after` anything
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
      let before = scrubDeep(row.before);
      let after = scrubDeep(row.after);
      if (row.resourceType === "setting" && !(typeof row.resourceId === "string" && showable(row.resourceId))) {
        const hide = (s: unknown) => (s && typeof s === "object" && present((s as { value?: unknown }).value) ? { ...(s as object), value: HIDDEN } : s);
        before = hide(before);
        after = hide(after);
      }
      return { ...row, before, after };
    }),
  };
}
