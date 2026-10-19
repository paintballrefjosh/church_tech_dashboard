import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../src/db/schema";
import type { Db } from "../src/db/db.module";
import { VerifyService } from "../src/backup/verify.service";
import type { BackupService } from "../src/backup/backup.service";
import { storeBackup } from "../src/backup/backup-writer";
import { MemoryObjectStore } from "./helpers/memory-object-store";

/**
 * The stored-backup check against a real database with an in-memory object store (run on CockroachDB and YugabyteDB; see
 * db-stores.integration.test.ts for the setup). It empties `backups`, so use a scratch database.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("checking stored backups against a real database", () => {
  let pool: Pool;
  let db: Db;
  let store: MemoryObjectStore;
  let service: VerifyService;
  let notices: string[];
  let finished: Array<{ ok: boolean; result?: unknown; error?: string }>;
  let pending: Promise<void>[];

  const q = (text: string, params: unknown[] = []) => pool.query(text, params);
  const row = async (id: string) => (await q(`SELECT * FROM backups WHERE id = $1`, [id])).rows[0];

  function fakeBackupService(): BackupService {
    return {
      async beginOperation() {
        const tracker = {
          id: "op-1",
          phase: async () => undefined,
          progress: () => undefined,
          succeed: async (result: unknown) => void finished.push({ ok: true, result }),
          fail: async (error: string) => void finished.push({ ok: false, error }),
        };
        return { tracker, mutex: { lost: false, release: async () => undefined } };
      },
      async setOperationBackup() {
        return undefined;
      },
      background(_label: string, work: () => Promise<void>) {
        pending.push(work());
      },
      async notifyAdmins(title: string) {
        notices.push(title);
      },
    } as unknown as BackupService;
  }

  /** A real backup of the scratch database, stored under a key, with its row (finished `ageMinutes` ago). */
  async function addBackup(n: number, ageMinutes = 60): Promise<{ id: string; key: string }> {
    const key = `backups/verify-${n}.tar.gz`;
    const stored = await storeBackup({ db, store }, key, {
      id: `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`,
      name: `verify-test-${n}`,
      includeFiles: false,
      createdBy: null,
      appVersion: null,
      secretFingerprint: "fp",
    });
    const id = (await q(
      `INSERT INTO backups (name, kind, status, s3_key, size_bytes, sha256, created_at, finished_at)
       VALUES ($1, 'manual', 'ready', $2, $3, $4, now() - ($5 || ' minutes')::interval, now() - ($5 || ' minutes')::interval) RETURNING id`,
      [`verify-test-${n}`, key, stored.sizeBytes, stored.sha256, String(ageMinutes)],
    )).rows[0].id as string;
    return { id, key };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 4 });
    db = drizzle(pool, { schema }) as unknown as Db;
  });
  afterAll(async () => {
    await q(`DELETE FROM backups`).catch(() => undefined);
    await pool?.end();
  });
  beforeEach(async () => {
    await q(`DELETE FROM backups`);
    store = new MemoryObjectStore();
    notices = [];
    finished = [];
    pending = [];
    service = new VerifyService(db, store, fakeBackupService(), { register: () => undefined } as never);
  });

  it("the tick checks a fresh backup, records the pass, and leaves it alone afterwards", async () => {
    const b = await addBackup(1);
    await service.tick();
    const r = await row(b.id);
    expect(r.verified_at).not.toBeNull();
    expect(r.verify_error).toBeNull();
    expect(r.verify_tried_at).not.toBeNull();
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ ok: true, result: { checked: 1, failed: 0 } });
    await service.tick(); // nothing due now
    expect(finished).toHaveLength(1);
  });

  it("does not touch a backup that was only just made", async () => {
    const b = await addBackup(2, 0);
    await service.tick();
    expect((await row(b.id)).verified_at).toBeNull();
    expect(finished).toHaveLength(0);
  });

  it("a damaged file fails its check, is recorded with the reason, and the administrators hear once", async () => {
    const b = await addBackup(3);
    const entry = store.objects.get(b.key)!;
    const bad = Buffer.from(entry.data);
    bad[Math.floor(bad.length / 2)] ^= 0xff;
    store.objects.set(b.key, { data: bad, contentType: entry.contentType });

    await service.tick();
    let r = await row(b.id);
    expect(r.verified_at).toBeNull();
    expect(r.verify_error).toMatch(/\S/);
    expect(notices).toHaveLength(1);
    expect(finished[0]).toMatchObject({ ok: false });

    // Retried only after the wait, and a second failure does not announce itself again.
    await service.tick();
    expect(finished).toHaveLength(1);
    await q(`UPDATE backups SET verify_tried_at = now() - interval '7 hours' WHERE id = $1`, [b.id]);
    await service.tick();
    expect(finished).toHaveLength(2);
    expect(notices).toHaveLength(1);

    // Put the file right: the next try passes and clears the error.
    store.objects.set(b.key, entry);
    await q(`UPDATE backups SET verify_tried_at = now() - interval '7 hours' WHERE id = $1`, [b.id]);
    await service.tick();
    r = await row(b.id);
    expect(r.verified_at).not.toBeNull();
    expect(r.verify_error).toBeNull();
  });

  it("a file missing from the store is a failed check, not a crash", async () => {
    const b = await addBackup(4);
    store.objects.delete(b.key);
    await service.tick();
    const r = await row(b.id);
    expect(r.verify_error).toMatch(/could not be read/);
  });

  it("checking by hand runs in the background, and refuses a backup that is not ready or does not exist", async () => {
    const b = await addBackup(5, 0);
    const started = await service.startCheck({ id: "u" }, b.id);
    expect(started.operationId).toBe("op-1");
    await Promise.all(pending);
    expect((await row(b.id)).verified_at).not.toBeNull();

    await q(`UPDATE backups SET status = 'running' WHERE id = $1`, [b.id]);
    await expect(service.startCheck({ id: "u" }, b.id)).rejects.toThrow(/still being made/);
    await expect(service.startCheck({ id: "u" }, "00000000-0000-4000-8000-000000000999")).rejects.toThrow(/not found/i);
  });
});
