import { Injectable, Inject, BadRequestException, type OnModuleInit } from "@nestjs/common";
import { eq, asc } from "drizzle-orm";
import { findKnownSetting, findTogglePrerequisite } from "@church/shared";
import { DB, type Db } from "../db/db.module";
import { CACHE_ROOM, ClusterBus } from "../cluster/cluster-bus.service";
import { settings } from "../db/schema";
import { encryptSecret, decryptSecret, isEncrypted } from "./crypto";

function isSecretKey(key: string): boolean {
  return findKnownSetting(key)?.type === "secret";
}

/**
 * Settings are read on hot paths — MailerService alone issues 6 sequential
 * `get()` calls per email send, PlanningCenter and Printers add several more
 * per external API call. They change rarely, so a short TTL is fine; writes
 * invalidate the per-key entry immediately so admin edits feel instant.
 *
 * In-memory (per-process) because settings are small and universally read. A
 * write is also announced on the cluster bus so other nodes drop their copy
 * within about a second instead of waiting out the 60-second TTL.
 */
const TTL_MS = 60_000;
/**
 * How long the one request that refreshes an expired entry waits for the database before it
 * serves the old value instead. Every request reads a setting (the rate limiter), so without
 * this a database that stops answering stalls the whole API, liveness check included.
 */
const STALE_WAIT_MS = 1_500;

@Injectable()
export class SettingsService implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly bus: ClusterBus,
  ) {}

  onModuleInit(): void {
    // Another node changed a setting: forget our copy. Local only, so it never echoes.
    this.bus.onEvent((row) => {
      if (row.room !== CACHE_ROOM) return;
      if (row.event === "settings") {
        this.cache.clear();
        return;
      }
      if (row.event !== "setting") return;
      const key = (row.payload as { key?: string } | null)?.key;
      if (key) this.cache.delete(key);
    });
  }

  private cache = new Map<string, { at: number; value: unknown }>();
  /** One refresh per key at a time, so a stalled database holds at most one query per key. */
  private refreshing = new Map<string, Promise<unknown>>();

  async list(): Promise<Array<{ key: string; value: unknown; updatedAt: Date; updatedBy: string | null }>> {
    const rows = await this.db.select().from(settings).orderBy(asc(settings.key));
    // Decrypt secrets in place so the caller never has to know about the
    // wire format. Authorisation/redaction is the controller's job.
    return rows.map((r) => ({ ...r, value: this.decryptIfNeeded(r.key, r.value) }));
  }

  async get(key: string): Promise<unknown> {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
    const running = this.refreshing.get(key);
    // A refresh is already waiting on the database: the old value is the answer, at once.
    if (running && cached) return cached.value;
    const refresh = running ?? this.refresh(key);
    // Nothing to fall back on: wait for the database (the caller handles a failure).
    if (!cached) return refresh;
    // Something to fall back on: give the database a moment, then serve the old value rather than
    // stall (the refresh carries on and lands in the cache when the database answers).
    return Promise.race([
      refresh.catch(() => cached.value),
      new Promise<unknown>((resolve) => setTimeout(() => resolve(cached.value), STALE_WAIT_MS).unref()),
    ]);
  }

  private refresh(key: string): Promise<unknown> {
    const p = (async () => {
      const [row] = await this.db.select().from(settings).where(eq(settings.key, key)).limit(1);
      const value = this.decryptIfNeeded(key, row?.value);
      this.cache.set(key, { at: Date.now(), value });
      return value;
    })().finally(() => this.refreshing.delete(key));
    this.refreshing.set(key, p);
    return p;
  }

  /**
   * Public base URL (no trailing slash) for building clickable links in email.
   * Precedence: the operator-set `site.url` setting → `APP_URL` env →
   * `fallbackOrigin` (a request origin a caller happened to know). Returns ""
   * when none is known, in which case callers should emit a relative path.
   * `site.url` wins on purpose: the request origin is often an internal address
   * (localhost / a bind IP) that's useless in an email.
   */
  async publicBaseUrl(fallbackOrigin?: string): Promise<string> {
    const configured = await this.get("site.url");
    const fromSetting = typeof configured === "string" ? configured.trim() : "";
    const fromEnv = process.env.APP_URL?.split(",")[0]?.trim() ?? "";
    const fromOrigin =
      fallbackOrigin && /^https?:\/\//i.test(fallbackOrigin) ? fallbackOrigin.trim() : "";
    return (fromSetting || fromEnv || fromOrigin || "").replace(/\/+$/, "");
  }

  async set(key: string, value: unknown, byUserId: string | null): Promise<void> {
    // Provider "enable" toggles can't be switched on until their credentials
    // exist (e.g. Google sign-in needs a client id + secret). Enforced here so
    // it holds for every caller, not just the settings form. Turning a toggle
    // OFF is always allowed.
    await this.assertTogglePrereqs(key, value);
    // Secret-typed keys are encrypted at rest with an AUTH_SECRET-derived key.
    // Non-secrets are stored as-is. The cache holds plaintext on both sides
    // so downstream consumers don't see the cipher.
    const storedValue =
      isSecretKey(key) && typeof value === "string" && value.length > 0
        ? encryptSecret(value)
        : value;
    await this.db
      .insert(settings)
      .values({ key, value: storedValue as never, updatedBy: byUserId, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: storedValue as never, updatedBy: byUserId, updatedAt: new Date() },
      });
    this.cache.delete(key);
    this.bus.publish({ room: CACHE_ROOM, event: "setting", payload: { key } });
  }

  /**
   * Reject enabling a provider toggle while any required credential is still
   * empty. Reads the currently-stored requirements (the credentials are saved
   * on a different page, so they're already persisted by the time the toggle
   * is flipped). No-op for non-toggle keys and for any value other than `true`.
   */
  private async assertTogglePrereqs(key: string, value: unknown): Promise<void> {
    if (value !== true) return;
    const prereq = findTogglePrerequisite(key);
    if (!prereq) return;
    const missing: string[] = [];
    for (const req of prereq.requires) {
      const v = await this.get(req);
      if (typeof v !== "string" || v.trim() === "") {
        missing.push(findKnownSetting(req)?.label ?? req);
      }
    }
    if (missing.length > 0) {
      throw new BadRequestException(
        `Set the ${missing.join(" and ")} on the ${prereq.providerLabel} settings page before enabling ${prereq.providerLabel} sign-in.`,
      );
    }
  }

  private decryptIfNeeded(key: string, raw: unknown): unknown {
    if (!isSecretKey(key)) return raw;
    if (typeof raw !== "string") return raw;
    if (!isEncrypted(raw)) return raw; // legacy cleartext — works during rolling upgrade
    try {
      return decryptSecret(raw);
    } catch {
      // Mangled ciphertext (e.g. AUTH_SECRET rotated). Return null so the
      // operator notices the setting reads as "unset" and re-enters it.
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await this.db.delete(settings).where(eq(settings.key, key));
    this.cache.delete(key);
    this.bus.publish({ room: CACHE_ROOM, event: "setting", payload: { key } });
  }

  /** Every setting may have changed at once (a backup was restored): forget all cached values, here and on the other nodes. */
  invalidateAll(): void {
    this.cache.clear();
    this.bus.publish({ room: CACHE_ROOM, event: "settings" });
  }

  /** Drop the entire cache. Used by tests; not on any hot path. */
  invalidate(): void {
    this.cache.clear();
  }
}
