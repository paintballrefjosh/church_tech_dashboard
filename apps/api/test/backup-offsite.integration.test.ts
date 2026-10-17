import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { OFFSITE_KEYS, offsiteObjectKey } from "@church/shared";
import * as schema from "../src/db/schema";
import type { Db } from "../src/db/db.module";
import { OffsiteService } from "../src/backup/offsite.service";
import type { BackupService } from "../src/backup/backup.service";
import { MemoryObjectStore } from "./helpers/memory-object-store";

/**
 * The offsite copy against a real database with in-memory stores for both buckets (run on CockroachDB and
 * YugabyteDB; see db-stores.integration.test.ts for the setup). It empties `backups` and `backup_schedules`, so use a
 * scratch database.
 */
const url = process.env.TEST_DATABASE_URL;

const body = (n: number) => Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.alloc(n, n)]);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe.skipIf(!url)("offsite copies against a real database", () => {
  let pool: Pool;
  let db: Db;
  let local: MemoryObjectStore;
  let remote: MemoryObjectStore;
  let service: OffsiteService;
  let values: Record<string, unknown>;
  let notices: string[];
  let imported: { filename: string; data: Buffer }[];
  let scheduleId: string;
  let factoryCalls: number;

  const q = (text: string, params: unknown[] = []) => pool.query(text, params);

  /** The few BackupService members the offsite service uses, with a tracker that records what it was told. */
  function fakeBackupService(): BackupService {
    return {
      async beginOperation() {
        const tracker = { id: "op-1", progress: () => undefined, succeed: async () => undefined, fail: async () => undefined };
        return { tracker, mutex: { lost: false, release: async () => undefined } };
      },
      async setOperationBackup() {
        return undefined;
      },
      background(_label: string, work: () => Promise<void>) {
        void work();
      },
      async notifyAdmins(title: string) {
        notices.push(title);
      },
      async importUpload(_user: unknown, filename: string, stream: Readable) {
        const parts: Buffer[] = [];
        for await (const c of stream) parts.push(Buffer.from(c as Uint8Array));
        imported.push({ filename, data: Buffer.concat(parts) });
        return { backupId: "imported-1", operationId: "op-2" };
      },
    } as unknown as BackupService;
  }

  /** A ready scheduled backup whose archive is in the local store. */
  async function addBackup(n: number, o: { when?: string; offsite?: boolean; kind?: string } = {}): Promise<{ id: string; key: string; data: Buffer; when: Date }> {
    const data = body(n * 10);
    const when = new Date(o.when ?? `2026-10-${String(n).padStart(2, "0")}T03:00:00Z`);
    const id = (await q(
      `INSERT INTO backups (name, kind, status, schedule_id, s3_key, size_bytes, sha256, created_at)
       VALUES ($1, $2, 'ready', $3, $4, $5, $6, $7) RETURNING id`,
      [`offsite-test-${n}`, o.kind ?? "scheduled", scheduleId, `backups/local-${n}.tar.gz`, data.length, sha(data), when],
    )).rows[0].id as string;
    local.objects.set(`backups/local-${n}.tar.gz`, { data, contentType: "application/gzip" });
    return { id, key: `backups/local-${n}.tar.gz`, data, when };
  }

  const row = async (id: string) => (await q(`SELECT * FROM backups WHERE id = $1`, [id])).rows[0];
  const remoteKeys = () => [...remote.objects.keys()].sort();

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 4 });
    db = drizzle(pool, { schema }) as unknown as Db;
  });
  afterAll(async () => {
    await q(`DELETE FROM backups`).catch(() => undefined);
    await q(`DELETE FROM backup_schedules`).catch(() => undefined);
    await pool?.end();
  });
  beforeEach(async () => {
    await q(`DELETE FROM backups`);
    await q(`DELETE FROM backup_schedules`);
    scheduleId = (await q(`INSERT INTO backup_schedules (name, frequency, time_of_day, timezone) VALUES ('offsite-test', 'daily', '03:00', 'UTC') RETURNING id`)).rows[0].id;
    local = new MemoryObjectStore();
    remote = new MemoryObjectStore();
    notices = [];
    imported = [];
    factoryCalls = 0;
    values = {
      [OFFSITE_KEYS.enabled]: true,
      [OFFSITE_KEYS.endpoint]: "s3.offsite.example",
      [OFFSITE_KEYS.bucket]: "offsite-bucket",
      [OFFSITE_KEYS.region]: "us-east-1",
      [OFFSITE_KEYS.prefix]: "church/",
      [OFFSITE_KEYS.accessKey]: "AK",
      [OFFSITE_KEYS.secretKey]: "SK",
      [OFFSITE_KEYS.pathStyle]: true,
      [OFFSITE_KEYS.keep]: 3,
    };
    service = new OffsiteService(
      db,
      local,
      () => {
        factoryCalls++;
        return remote;
      },
      { get: async (k: string) => values[k] } as never,
      fakeBackupService(),
      { register: () => undefined } as never,
    );
  });

  it("copies a scheduled backup byte for byte, checks it and records where it went", async () => {
    const b = await addBackup(1);
    await service.tick();
    const key = offsiteObjectKey("church/", b.when, b.id);
    expect(remote.objects.get(key)?.data.equals(b.data)).toBe(true);
    const r = await row(b.id);
    expect(r.offsite_key).toBe(key);
    expect(r.offsite_at).not.toBeNull();
    expect(r.offsite_error).toBeNull();
    expect(r.offsite_dest).toMatch(/^[0-9a-f]{16}$/);
    // Nothing waits now, so the next tick does no work.
    const before = remote.objects.size;
    await service.tick();
    expect(remote.objects.size).toBe(before);
    const s = await service.status();
    expect(s).toMatchObject({ enabled: true, configured: true, problem: null, pending: 0, failing: 0, copied: 1 });
    expect(s.lastCopyAt).not.toBeNull();
    expect(s.destination).toMatchObject({ bucket: "offsite-bucket", folder: "church/" });
    expect(JSON.stringify(s)).not.toContain("SK");
  });

  it("does nothing while switched off, and copies nothing from a schedule that opted out or a manual backup", async () => {
    await addBackup(1);
    values[OFFSITE_KEYS.enabled] = false;
    await service.tick();
    expect(remote.objects.size).toBe(0);
    values[OFFSITE_KEYS.enabled] = true;
    await q(`UPDATE backup_schedules SET offsite = false`);
    await service.tick();
    expect(remote.objects.size).toBe(0);
    await q(`UPDATE backup_schedules SET offsite = true`);
    await addBackup(2, { kind: "manual" });
    await service.tick();
    expect(remoteKeys()).toHaveLength(1); // only the scheduled one
  });

  it("copies one chosen backup of any kind when asked", async () => {
    const m = await addBackup(5, { kind: "manual" });
    const started = await service.startCopy({ id: "u1" }, m.id);
    expect(started.operationId).toBe("op-1");
    await new Promise((r) => setTimeout(r, 200));
    expect((await row(m.id)).offsite_key).not.toBeNull();
    expect(remote.objects.size).toBe(1);
  });

  it("keeps only the newest copies in the bucket and leaves other files alone", async () => {
    remote.objects.set("church/readme.txt", { data: Buffer.from("hi"), contentType: "text/plain" });
    for (const n of [1, 2, 3, 4, 5]) await addBackup(n);
    await service.tick(); // keep = 3: the three newest are wanted
    const keys = remoteKeys();
    expect(keys.filter((k) => k !== "church/readme.txt")).toHaveLength(3);
    expect(keys).toContain("church/readme.txt");
    // Backup 5 is the newest and is in the bucket; 1 and 2 never were copied.
    const r5 = await row((await q(`SELECT id FROM backups WHERE name = 'offsite-test-5'`)).rows[0].id);
    expect(r5.offsite_key).not.toBeNull();
    const r1 = (await q(`SELECT offsite_key FROM backups WHERE name = 'offsite-test-1'`)).rows[0];
    expect(r1.offsite_key).toBeNull();
    // A sixth backup pushes the oldest copy out, and its row stops claiming a copy.
    await addBackup(6);
    await service.tick();
    expect(remoteKeys().filter((k) => k !== "church/readme.txt")).toHaveLength(3);
    const r3 = (await q(`SELECT offsite_key, offsite_at FROM backups WHERE name = 'offsite-test-3'`)).rows[0];
    expect(r3.offsite_key).toBeNull();
    expect(r3.offsite_at).not.toBeNull(); // copied once: not queued again
    await service.tick();
    expect(remoteKeys().filter((k) => k !== "church/readme.txt")).toHaveLength(3);
  });

  it("keeps every copy when keep is 0", async () => {
    values[OFFSITE_KEYS.keep] = 0;
    for (const n of [1, 2, 3, 4]) await addBackup(n);
    await service.tick();
    expect(remote.objects.size).toBe(4);
  });

  it("records a failure, tells the administrators once, backs off, and succeeds on a later try", async () => {
    const b = await addBackup(1);
    const c = await addBackup(2);
    let failing = true;
    const realPut = remote.put.bind(remote);
    remote.put = async (key, stream, type, size) => {
      if (failing) throw new Error("AccessDenied: the key cannot write");
      return realPut(key, stream, type, size);
    };
    await service.tick();
    expect(remote.objects.size).toBe(0);
    expect((await row(b.id)).offsite_error).toContain("AccessDenied");
    expect(notices).toHaveLength(1); // one notice for two failing backups
    let s = await service.status();
    expect(s).toMatchObject({ failing: 2, copied: 0 });
    expect(s.lastError).toContain("AccessDenied");
    // Straight away: backed off.
    failing = false;
    await service.tick();
    expect(remote.objects.size).toBe(0);
    // After the retry delay both go through and the errors clear.
    await q(`UPDATE backups SET offsite_tried_at = now() - interval '2 hours'`);
    await service.tick();
    expect(remote.objects.size).toBe(2);
    expect((await row(b.id)).offsite_error).toBeNull();
    expect((await row(c.id)).offsite_error).toBeNull();
    s = await service.status();
    expect(s).toMatchObject({ failing: 0, copied: 2, lastError: null });
  });

  it("refuses to keep a copy that is the wrong size or whose source no longer matches its checksum", async () => {
    const b = await addBackup(1);
    await q(`UPDATE backups SET sha256 = $2 WHERE id = $1`, [b.id, "0".repeat(64)]);
    await service.tick();
    expect(remote.objects.size).toBe(0); // removed again
    expect((await row(b.id)).offsite_error).toContain("checksum");

    const d = await addBackup(2);
    const realStat = remote.stat.bind(remote);
    remote.stat = async (key) => {
      const s = await realStat(key);
      return s ? { size: s.size - 1 } : s;
    };
    await q(`UPDATE backups SET offsite_tried_at = now() - interval '2 hours'`);
    await service.tick();
    expect((await row(d.id)).offsite_error).toContain("wrong size");
    expect((await row(d.id)).offsite_key).toBeNull();
  });

  it("copies to a new bucket when the destination changes", async () => {
    const b = await addBackup(1);
    await service.tick();
    expect((await row(b.id)).offsite_key).not.toBeNull();
    const first = (await row(b.id)).offsite_dest;
    const other = new MemoryObjectStore();
    remote = other;
    values[OFFSITE_KEYS.bucket] = "second-bucket";
    expect((await service.status()).pending).toBe(1);
    await service.tick();
    expect(other.objects.size).toBe(1);
    expect((await row(b.id)).offsite_dest).not.toBe(first);
  });

  it("refuses the app's own bucket, and says what is missing", async () => {
    const saved = { e: process.env.S3_ENDPOINT, b: process.env.S3_BUCKET, a: process.env.S3_ACCESS_KEY, s: process.env.S3_SECRET_KEY };
    process.env.S3_ENDPOINT = "s3.offsite.example";
    process.env.S3_BUCKET = "offsite-bucket";
    process.env.S3_ACCESS_KEY = "x";
    process.env.S3_SECRET_KEY = "y";
    try {
      const s = await service.status();
      expect(s.problem).toContain("bucket this site keeps its own files");
      expect(s.destination).toBeNull();
      await addBackup(1);
      await service.tick();
      expect(remote.objects.size).toBe(0);
      expect((await service.test()).ok).toBe(false);
    } finally {
      for (const [k, v] of [["S3_ENDPOINT", saved.e], ["S3_BUCKET", saved.b], ["S3_ACCESS_KEY", saved.a], ["S3_SECRET_KEY", saved.s]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    values[OFFSITE_KEYS.secretKey] = "";
    const missing = await service.status();
    expect(missing).toMatchObject({ configured: false, missing: "the secret key" });
  });

  it("tests the connection: write, read back, delete; and reports a key that cannot delete", async () => {
    let t = await service.test();
    expect(t).toMatchObject({ ok: true, canDelete: true });
    expect(remote.objects.size).toBe(0);
    const realRemove = remote.remove.bind(remote);
    remote.remove = async () => {
      throw new Error("AccessDenied");
    };
    t = await service.test();
    expect(t).toMatchObject({ ok: true, canDelete: false });
    expect(t.message).toContain("write but not delete");
    remote.remove = realRemove;
    remote.list = async () => {
      throw new Error("NoSuchBucket");
    };
    t = await service.test();
    expect(t.ok).toBe(false);
    expect(t.message).toContain("NoSuchBucket");
  });

  it("warns when old copies cannot be deleted, and keeps the rows that still have a copy", async () => {
    values[OFFSITE_KEYS.keep] = 1;
    const a = await addBackup(1);
    await service.tick(); // copies backup 1
    await addBackup(2);
    remote.remove = async () => {
      throw new Error("AccessDenied");
    };
    await service.tick();
    expect(remote.objects.size).toBe(2);
    expect((await service.status()).warnings.join(" ")).toContain("could not be deleted");
    expect((await row(a.id)).offsite_key).not.toBeNull();
  });

  it("lists the copies in the bucket and brings one back, but only one of ours", async () => {
    const b = await addBackup(1);
    await service.tick();
    const stranger = offsiteObjectKey("church/", new Date("2026-09-01T00:00:00Z"), "9f9f9f9f-0000-4000-8000-000000000009");
    remote.objects.set(stranger, { data: body(7), contentType: "application/gzip" });
    remote.objects.set("church/notes.txt", { data: Buffer.from("x"), contentType: "text/plain" });
    const list = await service.objects();
    expect(list.map((o) => o.name)).toEqual([expect.stringContaining("20261001"), expect.stringContaining("20260901")]);
    expect(list[0]).toMatchObject({ backupId: b.id, sizeBytes: b.data.length });
    expect(list[1]?.backupId).toBeNull();

    const started = await service.fetch({ id: "u1" }, stranger);
    expect(started).toEqual({ backupId: "imported-1", operationId: "op-2" });
    expect(imported[0]?.filename).toBe(stranger.slice("church/".length));
    expect(imported[0]?.data.equals(body(7))).toBe(true);

    await expect(service.fetch({ id: "u1" }, "church/notes.txt")).rejects.toThrow(/not a backup copy/);
    await expect(service.fetch({ id: "u1" }, "other/church-dashboard-20260901T000000Z-aaaaaaaa.tar.gz")).rejects.toThrow(/not a backup copy/);
    await expect(service.fetch({ id: "u1" }, offsiteObjectKey("church/", new Date("2020-01-01T00:00:00Z"), "aaaaaaaa-0000-4000-8000-000000000000"))).rejects.toThrow(/no longer in the bucket/);
  });

  it("reaches the copies while copying is switched off (a fresh install looking for old ones)", async () => {
    remote.objects.set(offsiteObjectKey("church/", new Date("2026-09-01T00:00:00Z"), "9f9f9f9f-0000-4000-8000-000000000009"), { data: body(3), contentType: "application/gzip" });
    values[OFFSITE_KEYS.enabled] = false;
    expect(await service.objects()).toHaveLength(1);
    await expect(service.startCopy({ id: "u1" })).rejects.toThrow(/switched off/);
    expect(factoryCalls).toBeGreaterThan(0);
  });
});
