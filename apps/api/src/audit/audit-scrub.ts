/** What replaces a secret in a stored or returned snapshot. */
export const HIDDEN = "[hidden]";

/** A key that names a credential. */
const SECRET_KEY = /pass(word)?|secret|token|authorization|bearer|community|private.?key|api.?key|credential|cookie/i;

/** Keys that contain one of those words but hold an identifier or a count, never the credential (`tokenId`, `prefix`). */
const BENIGN_KEY = /(Id|_id|Prefix|_prefix|At|_at|Count|_count)$/;

/**
 * Strings and objects can be a credential. Booleans (`hasPassword`) and numbers (a backup summary counts rows per
 * table, `api_tokens: 3`) cannot, and null or empty means "not set", which is worth keeping visible.
 */
const hideable = (v: unknown) => (typeof v === "string" && v !== "") || (typeof v === "object" && v !== null);

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key) && !BENIGN_KEY.test(key);
}

/**
 * A copy of an audit snapshot with the value under every credential-looking key (at any depth) replaced by
 * `[hidden]`. Booleans and numbers stay (`hasPassword: true`, a per-table row count) and so do null and empty values, so "not set"
 * still reads. A snapshot is whatever the route answered with, and nothing forces a route to strip its secrets
 * first (a monitor's `Authorization` header), so the audit writer applies this to every row.
 */
export function scrubSnapshot(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubSnapshot);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKey(k) && hideable(v) ? HIDDEN : scrubSnapshot(v);
    }
    return out;
  }
  return value;
}

/** True when scrubbing would change the snapshot. */
export function needsScrub(value: unknown): boolean {
  return JSON.stringify(scrubSnapshot(value)) !== JSON.stringify(value);
}
