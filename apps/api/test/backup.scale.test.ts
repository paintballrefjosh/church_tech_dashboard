import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import * as schema from "../src/db/schema";
import type { Db } from "../src/db/db.module";
import { backedUpTables } from "../src/backup/backup-schema";
import { storeBackup } from "../src/backup/backup-writer";
import { gunzipped } from "../src/backup/archive";
import { computeDiff } from "../src/backup/backup-diff";
import { applyRestore } from "../src/backup/backup-restore";
import { MemoryObjectStore } from "./helpers/memory-object-store";

/**
 * How the backup engine copes with a site far bigger than a church's: hundreds of thousands of rows
 * and about 200 MB of text. Prints timings and peak memory. Slow, and it empties the scratch database,
 * so it only runs when asked:
 *
 *   BACKUP_SCALE=1 TEST_DATABASE_URL=postgresql://root@host:26257/scratch?sslmode=disable \
 *     pnpm --filter @church/api exec vitest run test/backup.scale.test.ts
 */
const url = process.env.TEST_DATABASE_URL;
const run = process.env.BACKUP_SCALE === "1";
/** 1 = about 330,000 rows; 0.1 for a quick look. */
const factor = Number(process.env.BACKUP_SCALE_FACTOR ?? "1");
const n = (base: number) => Math.max(10, Math.round(base * factor));

describe.skipIf(!url || !run)("backup engine at scale", () => {
  let pool: Pool;
  let db: Db;
  const store = new MemoryObjectStore();
  let peak = 0;
  let sampler: NodeJS.Timeout;

  const x = (q: ReturnType<typeof sql>) => db.execute(q);
  // The scratch database: truncating is far quicker than deleting hundreds of thousands of rows one by one.
  const wipe = () =>
    x(sql`TRUNCATE ${sql.join(backedUpTables().map((t) => sql.identifier(t.name)), sql`, `)} CASCADE`);
  const secs = (t0: number) => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(0)} MB`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 10 });
    db = drizzle(pool, { schema }) as unknown as Db;
    sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 200);
    await wipe();
  }, 600_000);
  afterAll(async () => {
    clearInterval(sampler);
    await pool?.end();
  });

  it("backs up, compares and restores a large site", async () => {
    let t0 = Date.now();
    await x(sql`INSERT INTO users (id, name, email) SELECT gen_random_uuid(), 'User ' || g, 'user' || g || '@example.org' FROM generate_series(1, 300) g`);
    // One row per user number, so seeding joins instead of running a subquery per row.
    await x(sql`DROP TABLE IF EXISTS seed_users`);
    await x(sql`CREATE TABLE seed_users AS SELECT id, (row_number() OVER (ORDER BY id) - 1) AS n FROM users`);
    await x(sql`INSERT INTO tickets (id, title, description, created_by_user_id)
      SELECT gen_random_uuid(), 'Ticket ' || g, repeat('describe the problem in some detail ', 20), u.id FROM generate_series(1, ${n(30000)}) g JOIN seed_users u ON u.n = g % 300`);
    await x(sql`INSERT INTO ticket_comments (ticket_id, author_user_id, body)
      SELECT t.id, t.created_by_user_id, 'comment ' || g || repeat(' words', 30) FROM tickets t, generate_series(1, 3) g`);
    await x(sql`INSERT INTO notes (id, owner_user_id, title, body) SELECT gen_random_uuid(), u.id, 'Note ' || g, repeat('note text ', 100) FROM generate_series(1, ${n(20000)}) g JOIN seed_users u ON u.n = g % 300`);
    await x(sql`INSERT INTO wiki_pages (id, title, body, owner_user_id) SELECT gen_random_uuid(), 'Page ' || g, repeat('wiki body ', 400), u.id FROM generate_series(1, ${n(2000)}) g JOIN seed_users u ON u.n = 0`);
    await x(sql`INSERT INTO wiki_revisions (page_id, title, body) SELECT p.id, p.title, repeat('revision body ', 400) FROM wiki_pages p, generate_series(1, 10) g`);
    await x(sql`INSERT INTO notifications (recipient_user_id, kind, title, body) SELECT u.id, 'ticket.comment', 'Notice ' || g, repeat('x', 200) FROM generate_series(1, ${n(100000)}) g JOIN seed_users u ON u.n = g % 300`);
    const counts = await x(sql`SELECT (SELECT count(*) FROM tickets) t, (SELECT count(*) FROM ticket_comments) c, (SELECT count(*) FROM notes) n, (SELECT count(*) FROM wiki_revisions) r, (SELECT count(*) FROM notifications) f`);
    console.log(`seeded in ${secs(t0)}:`, JSON.stringify(counts.rows[0]));

    t0 = Date.now();
    const stored = await storeBackup({ db, store }, "backups/scale.tar.gz", { id: "s", name: "scale", includeFiles: false, createdBy: null, appVersion: "t", secretFingerprint: "fp" });
    const total = Object.values(stored.tableCounts).reduce((a, b) => a + b, 0);
    console.log(`backup: ${secs(t0)}, ${total} rows, ${mb(stored.sizeBytes)} compressed, peak rss ${mb(peak)}`);

    const archive = () => (async function* () { yield* gunzipped(await store.get("backups/scale.tar.gz")); })();
    const ctx = { backup: { id: "s", name: "scale", createdAt: new Date().toISOString() }, archive, secretFingerprint: "fp" };

    t0 = Date.now();
    const same = await computeDiff({ db, store }, ctx);
    console.log(`compare (identical): ${secs(t0)}, ${JSON.stringify(same.report.totals)}, peak rss ${mb(peak)}`);
    expect(same.report.totals).toMatchObject({ added: 0, removed: 0, changed: 0 });

    // A realistic rewind: thousands of rows edited, added and deleted since.
    await x(sql`UPDATE tickets SET status = 'closed' WHERE (number % 4) = 0`);
    await x(sql`DELETE FROM notifications WHERE (length(title) % 7) = 0`);
    await x(sql`DELETE FROM notes WHERE title LIKE 'Note 1%'`);
    await x(sql`INSERT INTO notes (id, owner_user_id, title, body) SELECT gen_random_uuid(), u.id, 'Added later ' || g, 'x' FROM generate_series(1, ${n(5000)}) g JOIN seed_users u ON u.n = 0`);
    t0 = Date.now();
    const diff = await computeDiff({ db, store }, ctx);
    console.log(`compare (changed): ${secs(t0)}, ${JSON.stringify(diff.report.totals)}, peak rss ${mb(peak)}`);

    t0 = Date.now();
    const phases: string[] = [];
    let last = Date.now();
    const counts2 = await applyRestore({ db, progress: (p) => { const now = Date.now(); phases.push(`${((now - last) / 1000).toFixed(1)}s before "${p.label}"`); last = now; } }, diff, { archive });
    console.log("restore phases:\n  " + phases.filter((l) => !l.startsWith("0.0s")).join("\n  "));
    console.log(`restore: ${secs(t0)}, ${JSON.stringify(counts2)}, peak rss ${mb(peak)}`);

    const after = await computeDiff({ db, store }, ctx);
    expect(after.report.totals).toMatchObject({ added: 0, removed: 0, changed: 0 });

    // The worst case: restoring into an empty database (every row is written).
    await wipe();
    t0 = Date.now();
    const empty = await computeDiff({ db, store }, ctx);
    console.log(`compare (empty db): ${secs(t0)}, ${JSON.stringify(empty.report.totals)}`);
    t0 = Date.now();
    const full = await applyRestore({ db }, empty, { archive });
    console.log(`restore into empty: ${secs(t0)}, ${JSON.stringify(full)}, peak rss ${mb(peak)}`);
    const final = await computeDiff({ db, store }, ctx);
    expect(final.report.totals).toMatchObject({ added: 0, removed: 0, changed: 0 });
    await x(sql`DROP TABLE IF EXISTS seed_users`);
  }, 3_600_000);
});
