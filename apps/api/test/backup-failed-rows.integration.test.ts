import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { Readable } from "node:stream";
import * as schema from "../src/db/schema";
import type { Db } from "../src/db/db.module";
import { BackupService } from "../src/backup/backup.service";
import { MemoryObjectStore } from "./helpers/memory-object-store";

/**
 * Failed backup rows against a real database (run on CockroachDB and YugabyteDB; see
 * db-stores.integration.test.ts for the setup). A file refused at the upload leaves no row, and the scheduler
 * tick sweeps old failed rows of any kind. It empties `backups`, so use a scratch database.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("failed backup rows against a real database", () => {
  let pool: Pool;
  let db: Db;
  let store: MemoryObjectStore;
  let service: BackupService;
  let userId: string;

  const q = (text: string, params: unknown[] = []) => pool.query(text, params);
  const names = async () => (await q(`SELECT name FROM backups ORDER BY name`)).rows.map((r) => r.name as string);

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 4 });
    db = drizzle(pool, { schema }) as unknown as Db;
    userId = (await q(`INSERT INTO users (email) VALUES ('backup-failed-rows@test.local') RETURNING id`)).rows[0].id;
  });
  afterAll(async () => {
    await q(`DELETE FROM backups`).catch(() => undefined);
    await q(`DELETE FROM users WHERE id = $1`, [userId]).catch(() => undefined);
    await pool?.end();
  });
  beforeEach(async () => {
    await q(`DELETE FROM backups`);
    store = new MemoryObjectStore();
    service = new BackupService(
      db,
      store,
      { acquireMutex: async () => ({ lost: false, release: async () => undefined }) } as never,
      { register: () => undefined } as never,
      { identity: { nodeId: "test" } } as never,
      { isRestoring: async () => false } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  async function addBackup(name: string, status: string, daysOld: number): Promise<string> {
    const key = `backups/${name}.tar.gz`;
    store.objects.set(key, { data: Buffer.from("x"), contentType: "application/gzip" });
    await q(`INSERT INTO backups (name, kind, status, s3_key, created_at) VALUES ($1, 'uploaded', $2, $3, now() - ($4 || ' days')::interval)`, [name, status, key, String(daysOld)]);
    return key;
  }

  it("a file refused at the upload leaves no backup row and no stored object", async () => {
    await expect(service.importUpload({ id: userId }, "junk.tar.gz", Readable.from([Buffer.from("this is not a backup")]), () => false)).rejects.toThrow(/not a backup file/);
    expect(await names()).toEqual([]);
    expect(store.objects.size).toBe(0);
  });

  it("the tick removes failed backups past their keep time, with their archives, and leaves the rest", async () => {
    const oldKey = await addBackup("old-failed", "failed", 8);
    await addBackup("new-failed", "failed", 1);
    await addBackup("old-ready", "ready", 30);
    await service.tick();
    expect(await names()).toEqual(["new-failed", "old-ready"]);
    expect(store.objects.has(oldKey)).toBe(false);
  });
});
