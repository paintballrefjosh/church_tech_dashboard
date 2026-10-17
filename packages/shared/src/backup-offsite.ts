/**
 * Offsite copies of backups (admin > Backups > Offsite): the pure rules, shared by the API and the pages.
 * A copy is the same `.tar.gz` the Backups page makes, put in a second S3-compatible bucket that is NOT the
 * app's own, named so that a plain listing sorts oldest to newest.
 */

export const OFFSITE_KEYS = {
  enabled: "backup.offsite.enabled",
  endpoint: "backup.offsite.endpoint",
  bucket: "backup.offsite.bucket",
  region: "backup.offsite.region",
  prefix: "backup.offsite.prefix",
  accessKey: "backup.offsite.access_key",
  secretKey: "backup.offsite.secret_key",
  pathStyle: "backup.offsite.path_style",
  keep: "backup.offsite.keep",
} as const;

/** The most copies "keep" may ask for. */
export const OFFSITE_MAX_KEEP = 1000;

/** Failed copies are retried this often (a bucket that is down for a while should not be hammered). */
export const OFFSITE_RETRY_MINUTES = 30;

/** An offsite copy older than this on the newest backup that should have been copied is a problem. */
export const OFFSITE_STALE_DAYS = 8;

/**
 * Normalise the folder inside the bucket: no leading slash, one trailing slash, or empty for the bucket's top.
 * Returns an error message for something that cannot be a safe key prefix.
 */
export function normaliseOffsitePrefix(raw: string): { ok: true; prefix: string } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (/[\u0000-\u001f\u007f\\]/.test(trimmed)) return { ok: false, error: "The folder cannot contain control characters or backslashes." };
  const parts = trimmed.split("/").filter((p) => p !== "");
  if (parts.some((p) => p === "." || p === "..")) return { ok: false, error: 'The folder cannot contain "." or ".." parts.' };
  if (trimmed.length > 200) return { ok: false, error: "The folder is too long (200 characters at most)." };
  return { ok: true, prefix: parts.length === 0 ? "" : `${parts.join("/")}/` };
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** `church-dashboard-20261016T031500Z-1a2b3c4d.tar.gz`: sorts by time, and says what it is when seen alone. */
export function offsiteObjectName(createdAt: Date, backupId: string): string {
  const d = createdAt;
  const stamp = `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  return `church-dashboard-${stamp}-${backupId.replace(/-/g, "").slice(0, 8)}.tar.gz`;
}

export function offsiteObjectKey(prefix: string, createdAt: Date, backupId: string): string {
  return `${prefix}${offsiteObjectName(createdAt, backupId)}`;
}

const NAME_RE = /^church-dashboard-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-[0-9a-f]{8}\.tar\.gz$/;

/** Whether a key in the folder is one of ours (and not something else somebody keeps there). */
export function isOffsiteArchiveKey(prefix: string, key: string): boolean {
  return key.startsWith(prefix) && NAME_RE.test(key.slice(prefix.length));
}

/** The time encoded in an offsite name, or null. */
export function offsiteKeyTime(prefix: string, key: string): Date | null {
  if (!key.startsWith(prefix)) return null;
  const m = NAME_RE.exec(key.slice(prefix.length));
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
}

/**
 * Which copies to delete so that only the newest `keep` remain. Only keys that are ours are ever considered;
 * `keep` of 0 keeps everything (nothing is ever deleted at the destination unless the person asked for that).
 */
export function offsiteKeysToDelete(prefix: string, keys: string[], keep: number): string[] {
  if (!Number.isFinite(keep) || keep <= 0) return [];
  const ours = keys.filter((k) => isOffsiteArchiveKey(prefix, k)).sort();
  return ours.length <= keep ? [] : ours.slice(0, ours.length - keep);
}

/** The first thing missing before copies can be made, or null. */
export function offsiteMissing(v: { endpoint: string; bucket: string; accessKey: string; secretKey: string }): string | null {
  if (!v.endpoint.trim()) return "the endpoint";
  if (!v.bucket.trim()) return "the bucket";
  if (!v.accessKey.trim()) return "the access key";
  if (!v.secretKey.trim()) return "the secret key";
  return null;
}
