import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasManagedMarker, DNS_MANAGED_MARKER, LEGACY_DNS_MANAGED_MARKER, dnsRecordCreateSchema } from "@lampstand/shared";
import { decryptSecret, encryptSecret } from "../src/settings/crypto";
import { deriveLegacyVapidKeys, deriveVapidKeys } from "../src/notifications/vapid";
import { sendWithLegacyFallback, type PushSender } from "../src/notifications/push.service";
import { acceptedSecretFingerprints, secretFingerprint } from "../src/backup/backup.service";
import { computeSyncPlan, type ExistingRecord } from "../src/dns/sync-plan";

// What was written before the rename to Lampstand (2026-11-08) must still be readable.

const SECRET = "a-test-auth-secret";
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = SECRET;
});
afterEach(() => {
  if (saved === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = saved;
});

describe("saved secrets", () => {
  /** A value exactly as the old code wrote it. */
  function legacyEncrypt(plain: string): string {
    const key = scryptSync(SECRET, Buffer.from("church-dashboard:settings:v1"), 32);
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return `enc:v1:${iv.toString("base64")}:${c.getAuthTag().toString("base64")}:${ct.toString("base64")}`;
  }

  it("reads a value saved before the rename", () => {
    expect(decryptSecret(legacyEncrypt("smtp-password"))).toBe("smtp-password");
  });
  it("writes new values under the new salt, which the old salt cannot open", () => {
    const enc = encryptSecret("fresh");
    expect(decryptSecret(enc)).toBe("fresh");
    const [, , iv, tag, ct] = enc.split(":");
    const legacyKey = scryptSync(SECRET, Buffer.from("church-dashboard:settings:v1"), 32);
    const d = createDecipheriv("aes-256-gcm", legacyKey, Buffer.from(iv!, "base64"));
    d.setAuthTag(Buffer.from(tag!, "base64"));
    expect(() => Buffer.concat([d.update(Buffer.from(ct!, "base64")), d.final()])).toThrow();
  });
  it("still fails for a value saved under another AUTH_SECRET", async () => {
    const enc = encryptSecret("x");
    process.env.AUTH_SECRET = "another-secret";
    vi.resetModules(); // the key is cached per process
    const fresh = await import("../src/settings/crypto");
    expect(() => fresh.decryptSecret(enc)).toThrow();
  });
});

describe("web push", () => {
  const target = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "p", auth: "a" } };
  const options = { subject: "https://example.org", keys: deriveVapidKeys(SECRET), urgent: false };
  const legacy = () => deriveLegacyVapidKeys(SECRET);

  it("derives a different pair for the old salt", () => {
    expect(deriveLegacyVapidKeys(SECRET).publicKey).not.toBe(deriveVapidKeys(SECRET).publicKey);
  });
  it("sends with the new key and never touches the old one when that works", async () => {
    const used: string[] = [];
    const sender: PushSender = async (_t, _b, o) => void used.push(o.keys.publicKey);
    await sendWithLegacyFallback(sender, target, "{}", options, legacy);
    expect(used).toEqual([options.keys.publicKey]);
  });
  it("retries a refused key (a subscription from before the rename) with the old pair", async () => {
    const used: string[] = [];
    const sender: PushSender = async (_t, _b, o) => {
      used.push(o.keys.publicKey);
      if (o.keys.publicKey === options.keys.publicKey) throw Object.assign(new Error("forbidden"), { statusCode: 403 });
    };
    await sendWithLegacyFallback(sender, target, "{}", options, legacy);
    expect(used).toEqual([options.keys.publicKey, legacy().publicKey]);
  });
  it("reports the first failure when the old pair is refused too, and does not retry other errors", async () => {
    const refuse: PushSender = async () => {
      throw Object.assign(new Error("gone"), { statusCode: 403 });
    };
    await expect(sendWithLegacyFallback(refuse, target, "{}", options, legacy)).rejects.toMatchObject({ statusCode: 403 });
    let calls = 0;
    const gone: PushSender = async () => {
      calls++;
      throw Object.assign(new Error("gone"), { statusCode: 410 });
    };
    await expect(sendWithLegacyFallback(gone, target, "{}", options, legacy)).rejects.toMatchObject({ statusCode: 410 });
    expect(calls).toBe(1);
  });
});

describe("backup fingerprint", () => {
  it("accepts the one backups carry from before the rename, as well as the current one", () => {
    const [current, old] = acceptedSecretFingerprints();
    expect(current).toBe(secretFingerprint());
    expect(old).not.toBe(current);
    expect(old).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("DNS managed marker", () => {
  it("recognises the old marker as well as the new one", () => {
    expect(hasManagedMarker(DNS_MANAGED_MARKER)).toBe(true);
    expect(hasManagedMarker(`note (${LEGACY_DNS_MANAGED_MARKER})`)).toBe(true);
    expect(hasManagedMarker("hand-made")).toBe(false);
    expect(hasManagedMarker(null)).toBe(false);
  });
  it("keeps either marker out of a hand-made record's comment", () => {
    const base = { name: "a", ttl: 300, data: { type: "A", ipAddress: "10.0.0.1" } };
    expect(dnsRecordCreateSchema.safeParse({ ...base, comments: "mine" }).success).toBe(true);
    for (const comments of [DNS_MANAGED_MARKER, LEGACY_DNS_MANAGED_MARKER]) {
      expect(dnsRecordCreateSchema.safeParse({ ...base, comments }).success).toBe(false);
    }
  });
  it("rewrites a synced record that still has the old marker, once, and leaves a current one alone", () => {
    const NOW = new Date("2026-10-03T12:00:00Z");
    const mk = (comments: string): ExistingRecord => ({ zone: "int.example.org", name: "pc.int.example.org", type: "A", value: "10.10.0.5", ttl: 300, comments });
    const run = (existing: ExistingRecord[]) =>
      computeSyncPlan({
        enabled: true,
        zone: "int.example.org",
        ptr: false,
        ttl: 300,
        staleDays: 14,
        now: NOW,
        hosts: [{ id: "h1", ipAddress: "10.10.0.5", dnsName: null, unifiName: "pc", netbiosName: null, lastSeenAt: NOW }],
        zones: ["int.example.org"],
        existing,
        ledger: new Map(),
      });
    const old = run([mk(LEGACY_DNS_MANAGED_MARKER)]);
    expect(old.actions.map((a) => [a.op, a.reason])).toEqual([["update", "Marker renamed"]]);
    const current = run([mk(DNS_MANAGED_MARKER)]);
    expect(current.actions).toEqual([]);
  });
});
