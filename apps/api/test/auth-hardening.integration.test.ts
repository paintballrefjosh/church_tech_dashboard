import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { authenticator } from "otplib";
import { AuthService, hashRecoveryCode } from "../src/auth/auth.service";
import { AuthTokensService } from "../src/auth-tokens/auth-tokens.service";
import { RateLimitService } from "../src/cluster/rate-limit.service";
import { encryptSecret, isEncrypted } from "../src/settings/crypto";
import * as schema from "../src/db/schema";
import { createHash } from "node:crypto";

/**
 * Real-database checks for the sign-in hardening: one-time TOTP codes, atomic recovery codes, single-use
 * reset links, the per-account failure counter and session revocation. Needs TEST_DATABASE_URL (a migrated
 * scratch database; the tables it touches are emptied) and AUTH_SECRET.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("sign-in hardening against a real database", () => {
  let pool: Pool;
  let auth: AuthService;
  let tokens: AuthTokensService;
  let limiter: RateLimitService;
  let userId = "";

  const q = <T extends Record<string, unknown>>(text: string, params: unknown[] = []) => pool.query<T>(text, params);

  beforeAll(async () => {
    process.env.AUTH_SECRET ??= "integration-test-secret";
    pool = new Pool({ connectionString: url, max: 10 });
    const db = drizzle(pool, { schema });
    for (const t of ["auth_tokens", "totp_secrets", "credentials", "rate_limit_buckets"]) await q(`DELETE FROM ${t}`);
    await q(`DELETE FROM users WHERE email LIKE 'hard-%@test.local'`);
    const bus = { publish: () => undefined, onEvent: () => undefined };
    auth = new AuthService(db as never, bus as never);
    tokens = new AuthTokensService(db as never, auth, {} as never, { get: async () => "", publicBaseUrl: async () => "" } as never);
    limiter = new RateLimitService(pool as never, { register: () => undefined } as never);
    userId = (await q<{ id: string }>(`INSERT INTO users (email, name, totp_enabled) VALUES ('hard-a@test.local', 'A', true) RETURNING id`)).rows[0]!.id;
  });
  afterAll(async () => {
    await pool?.end();
  });

  describe("two-factor", () => {
    const secret = authenticator.generateSecret();
    const recovery = ["AAAAA-BBBBB-CCCCC-DDDDD", "EEEEE-FFFFF-GGGGG-HHHHH"];

    beforeAll(async () => {
      await q(`INSERT INTO totp_secrets (user_id, secret, recovery_codes) VALUES ($1, $2, $3)`, [userId, secret, recovery.map(hashRecoveryCode)]);
    });

    it("reads a plaintext secret from before encryption existed, and encrypts it in place", async () => {
      expect(await auth.getTotpSecret(userId)).toBe(secret);
      const stored = (await q<{ secret: string }>(`SELECT secret FROM totp_secrets WHERE user_id = $1`, [userId])).rows[0]!.secret;
      expect(isEncrypted(stored)).toBe(true);
      expect(await auth.getTotpSecret(userId)).toBe(secret);
    });

    it("accepts a code once and refuses it again within its window", async () => {
      const code = authenticator.generate(secret);
      expect(await auth.verifyTotpCode(userId, code)).toBe(true);
      expect(await auth.verifyTotpCode(userId, code)).toBe(false);
      expect(await auth.verifyTotpCode(userId, "000000")).toBe(false);
    });

    it("lets exactly one of many simultaneous uses of a code through", async () => {
      await q(`UPDATE totp_secrets SET last_step = NULL WHERE user_id = $1`, [userId]);
      const code = authenticator.generate(secret);
      const results = await Promise.all(Array.from({ length: 8 }, () => auth.verifyTotpCode(userId, code)));
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it("spends a recovery code exactly once, even when used at the same moment", async () => {
      const results = await Promise.all(Array.from({ length: 6 }, () => auth.consumeRecoveryCode(userId, "aaaaa-bbbbb-ccccc-ddddd")));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await auth.consumeRecoveryCode(userId, recovery[0]!)).toBe(false);
      expect(await auth.consumeRecoveryCode(userId, recovery[1]!)).toBe(true);
      expect(await auth.consumeRecoveryCode(userId, "ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ")).toBe(false);
    });

    it("stores a secret encrypted from the start", async () => {
      await q(`UPDATE totp_secrets SET secret = $2 WHERE user_id = $1`, [userId, encryptSecret(secret)]);
      expect(await auth.getTotpSecret(userId)).toBe(secret);
    });
  });

  describe("reset links", () => {
    const plaintext = "t".repeat(43);
    const hash = createHash("sha256").update(plaintext).digest("hex");

    it("can be used by only one of several simultaneous requests", async () => {
      await q(`INSERT INTO auth_tokens (user_id, kind, token_hash, expires_at) VALUES ($1, 'reset', $2, now() + interval '1 hour')`, [userId, hash]);
      const results = await Promise.allSettled(Array.from({ length: 5 }, () => tokens.consume(plaintext, "a-new-password-1")));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      await expect(tokens.consume(plaintext, "a-new-password-2")).rejects.toThrow(/Invalid or expired/);
    });

    it("signs the account out and spends the account's other outstanding links", async () => {
      const before = Number((await q<{ session_version: number }>(`SELECT session_version FROM users WHERE id = $1`, [userId])).rows[0]!.session_version);
      const second = "u".repeat(43);
      const third = "v".repeat(43);
      for (const p of [second, third]) {
        await q(`INSERT INTO auth_tokens (user_id, kind, token_hash, expires_at) VALUES ($1, 'reset', $2, now() + interval '1 hour')`, [userId, createHash("sha256").update(p).digest("hex")]);
      }
      await tokens.consume(second, "another-password-1");
      const after = Number((await q<{ session_version: number }>(`SELECT session_version FROM users WHERE id = $1`, [userId])).rows[0]!.session_version);
      expect(after).toBe(before + 1);
      await expect(tokens.consume(third, "another-password-2")).rejects.toThrow(/Invalid or expired/);
    });

    it("is refused for a disabled account", async () => {
      const p = "w".repeat(43);
      await q(`INSERT INTO auth_tokens (user_id, kind, token_hash, expires_at) VALUES ($1, 'reset', $2, now() + interval '1 hour')`, [userId, createHash("sha256").update(p).digest("hex")]);
      await q(`UPDATE users SET is_active = false WHERE id = $1`, [userId]);
      await expect(tokens.consume(p, "yet-another-pass-1")).rejects.toThrow(/Invalid or expired/);
      await q(`UPDATE users SET is_active = true WHERE id = $1`, [userId]);
    });

    it("sends at most one reset email per account in five minutes", async () => {
      const sent: string[] = [];
      const svc = new AuthTokensService(
        drizzle(pool, { schema }) as never,
        auth,
        { sendBestEffort: async (m: { to: string }) => void sent.push(m.to) } as never,
        { get: async () => "Church", publicBaseUrl: async () => "https://dash.example" } as never,
      );
      await q(`DELETE FROM auth_tokens WHERE user_id = $1`, [userId]);
      await svc.issue("reset", userId);
      await svc.issue("reset", userId);
      await svc.issue("reset", userId);
      expect(sent).toHaveLength(1);
      // An invite is not throttled.
      await svc.issue("invite", userId);
      expect(sent).toHaveLength(2);
    });
  });

  describe("per-account failure counter", () => {
    const window = 60_000;
    it("counts failures per account and reports when to retry", async () => {
      expect((await limiter.failures("someone@local", window)).count).toBe(0);
      for (let i = 0; i < 3; i++) await limiter.recordFailure("someone@local", window);
      const f = await limiter.failures("someone@local", window);
      expect(f.count).toBe(3);
      expect(f.retryAfterSec).toBeGreaterThan(0);
      expect((await limiter.failures("other@local", window)).count).toBe(0);
    });
    it("counts parallel failures without losing any, and clears on success", async () => {
      await Promise.all(Array.from({ length: 10 }, () => limiter.recordFailure("burst@local", window)));
      expect((await limiter.failures("burst@local", window)).count).toBe(10);
      await limiter.clearFailures("burst@local");
      expect((await limiter.failures("burst@local", window)).count).toBe(0);
    });
    it("forgets failures once the window has passed", async () => {
      await limiter.recordFailure("old@local", 1000);
      await q(`UPDATE rate_limit_buckets SET window_start = now() - interval '2 seconds' WHERE key = 'acct|old@local'`);
      expect((await limiter.failures("old@local", 1000)).count).toBe(0);
    });
  });

  describe("session revocation", () => {
    it("bumps the account's session version, once per call", async () => {
      // CockroachDB returns an integer column as a string through raw SQL.
      const read = async () => Number((await q<{ session_version: number }>(`SELECT session_version FROM users WHERE id = $1`, [userId])).rows[0]!.session_version);
      const v = await read();
      await auth.revokeSessions(userId);
      await auth.revokeSessions(userId);
      expect(await read()).toBe(v + 2);
      expect((await auth.loadUserById(userId))?.sessionVersion).toBe(v + 2);
    });
  });
});
