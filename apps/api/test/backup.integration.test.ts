import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackupDiffReport } from "@church/shared";
import * as schema from "../src/db/schema";
import type { Db } from "../src/db/db.module";
import { backedUpTables } from "../src/backup/backup-schema";
import { appliedMigrations, storeBackup } from "../src/backup/backup-writer";
import { gunzipped, readArchive } from "../src/backup/archive";
import { inspectArchive } from "../src/backup/backup-inspect";
import { computeDiff, type DiffOutput } from "../src/backup/backup-diff";
import { applyRestore } from "../src/backup/backup-restore";
import { keyOf, rowFingerprint, selectList, type Row } from "../src/backup/row-codec";
import { TABLE_REGISTRY } from "../src/backup/table-registry";
import { MemoryObjectStore } from "./helpers/memory-object-store";

/**
 * The backup engine against a real database: write a backup, change things, compare, restore.
 * Skipped unless TEST_DATABASE_URL points at a migrated scratch database (every backed-up table
 * is emptied first, so never point it at one you care about). Run it on CockroachDB and on
 * YugabyteDB:
 *
 *   TEST_DATABASE_URL=postgresql://root@host:26257/scratch?sslmode=disable \
 *     pnpm --filter @church/api exec vitest run test/backup.integration.test.ts
 */
const url = process.env.TEST_DATABASE_URL;

const id = (n: number, kind = "0") => `00000000-0000-4000-8${kind}00-${String(n).padStart(12, "0")}`;
const ids = {
  admin: id(1),
  member: id(2),
  group: id(10),
  ticketA: id(20),
  ticketB: id(21),
  folderRoot: id(30),
  folderChild: id(31),
  folderGrand: id(32),
  pageParent: id(40),
  pageChild: id(41),
  monitor: id(50),
  attach1: id(60),
  attach2: id(61),
  noteOwned: id(70),
};
const KEY1 = "attachments/note/one.png";
const KEY2 = "attachments/note/two.png";
const png = (n: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(n, n)]);

describe.skipIf(!url)("backup and restore against a real database", () => {
  let pool: Pool;
  let db: Db;
  let store: MemoryObjectStore;
  const options = { id: "bk-1", name: "Test backup", includeFiles: true, createdBy: null, appVersion: "test", secretFingerprint: "fp-a" };

  async function run(q: ReturnType<typeof sql>): Promise<void> {
    await db.execute(q);
  }

  async function wipe(): Promise<void> {
    for (const t of [...backedUpTables()].reverse()) await run(sql`DELETE FROM ${sql.identifier(t.name)}`);
  }

  async function seed(): Promise<void> {
    await db.insert(schema.users).values([
      { id: ids.admin, name: "Ada Admin", email: "ada@example.org" },
      { id: ids.member, name: "Mo Member", email: "mo@example.org" },
    ]);
    await db.insert(schema.groups).values({ id: ids.group, name: "admin" });
    await db.insert(schema.groupMemberships).values({ groupId: ids.group, userId: ids.admin });
    await db.insert(schema.credentials).values({ userId: ids.admin, passwordHash: "argon-hash-1" });
    await db.insert(schema.settings).values([
      { key: "site.name", value: "Grace Church" },
      { key: "smtp.password", value: "enc:v1:original" },
    ]);
    await db.insert(schema.tickets).values([
      { id: ids.ticketA, title: "Printer jam", description: "Second floor", createdByUserId: ids.member },
      { id: ids.ticketB, title: "Wifi down", description: "Hall", createdByUserId: ids.member, priority: "high" },
    ]);
    await db.insert(schema.ticketComments).values({ ticketId: ids.ticketA, authorUserId: ids.admin, body: "On it" });
    await db.insert(schema.wikiFolders).values([
      { id: ids.folderRoot, name: "Root" },
      { id: ids.folderChild, name: "Child", parentFolderId: ids.folderRoot },
      { id: ids.folderGrand, name: "Grand", parentFolderId: ids.folderChild },
    ]);
    await db.insert(schema.wikiPages).values([
      { id: ids.pageParent, title: "Parent page", body: "p", ownerUserId: ids.admin, parentFolderId: ids.folderRoot },
      { id: ids.pageChild, title: "Child page", body: "c", ownerUserId: ids.admin, parentId: ids.pageParent, parentFolderId: ids.folderGrand },
    ]);
    await db.insert(schema.monitors).values({ id: ids.monitor, name: "Website", kind: "http", target: "https://example.org", status: "up", consecutiveOks: 5 });
    await db.insert(schema.attachments).values([
      { id: ids.attach1, parentType: "note", parentId: id(99), filename: "one.png", contentType: "image/png", sizeBytes: png(10).length, storageKey: KEY1, uploaderUserId: ids.member },
      { id: ids.attach2, parentType: "note", parentId: id(99), filename: "two.png", contentType: "image/png", sizeBytes: png(20).length, storageKey: KEY2 },
    ]);
    await store.put(KEY1, png(10), "image/png");
    await store.put(KEY2, png(20), "image/png");
  }

  /** Every backed-up table's rows, fingerprinted over all columns, to compare two states exactly. */
  async function snapshot(): Promise<Record<string, Map<string, string>>> {
    const out: Record<string, Map<string, string>> = {};
    for (const t of backedUpTables()) {
      const cols = t.columns.map((c) => c.name);
      const map = new Map<string, string>();
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('TimeZone', 'UTC', true)`);
        const res = await tx.execute(sql`SELECT ${selectList(t, cols)} FROM ${sql.identifier(t.name)}`);
        for (const row of res.rows as Row[]) map.set(keyOf(row, t.pk), rowFingerprint(row, cols));
      });
      out[t.name] = map;
    }
    return out;
  }

  const stored = (key = "backups/bk-1.tar.gz") => store.objects.get(key)!.data;
  const archiveOf = (key = "backups/bk-1.tar.gz") => () =>
    (async function* () {
      yield* gunzipped(await store.get(key));
    })();

  async function backup(): Promise<void> {
    await storeBackup({ db, store }, "backups/bk-1.tar.gz", options);
  }

  async function compare(secretFingerprint = "fp-a", userId: string | null = null): Promise<DiffOutput> {
    return computeDiff(
      { db, store },
      { backup: { id: "bk-1", name: "Test backup", createdAt: new Date().toISOString() }, archive: archiveOf(), secretFingerprint, userId },
    );
  }

  const table = (report: BackupDiffReport, name: string) => report.groups.flatMap((g) => g.tables).find((t) => t.table === name);

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 5 });
    db = drizzle(pool, { schema }) as unknown as Db;
  });
  afterAll(async () => {
    await pool?.end();
  });
  beforeEach(async () => {
    store = new MemoryObjectStore();
    await wipe();
    await run(sql`DELETE FROM audit_log WHERE action IN ('after.backup', 'x.y')`);
    await seed();
  }, 120_000);

  it("writes a backup that checks out: counts, files and checksums, readable by an ordinary tar", async () => {
    await backup();
    const info = await inspectArchive(gunzipped(await store.get("backups/bk-1.tar.gz")));
    expect(info.manifest.tables.map((t) => t.name)).toEqual(backedUpTables().map((t) => t.name));
    expect(info.tableCounts.users).toBe(2);
    expect(info.tableCounts.tickets).toBe(2);
    expect(info.tableCounts.wiki_folders).toBe(3);
    expect(info.tableCounts.audit_log).toBeUndefined();
    expect(info.fileCount).toBe(2);
    expect(info.fileBytes).toBe(png(10).length + png(20).length);
    expect(info.manifest.schemaMigrations).toBe(await appliedMigrations(db));

    // The file is a plain .tar.gz: a person can open it with any archive tool.
    const dir = mkdtempSync(join(tmpdir(), "bk-"));
    const file = join(dir, "b.tar.gz");
    writeFileSync(file, stored());
    const listed = spawnSync("tar", ["tzf", file], { encoding: "utf8" });
    expect(listed.status).toBe(0);
    expect(listed.stdout).toContain("manifest.json");
    expect(listed.stdout).toContain("tables/users/000001.ndjson");
    expect(listed.stdout).toContain(`files/${KEY1}`);
    expect(listed.stdout).toContain("summary.json");
  });

  it("does not put skipped tables, such as the audit log, in a backup", async () => {
    await run(sql`INSERT INTO audit_log (action, resource_type) VALUES ('x.y', 'z')`);
    await backup();
    const seen = new Set<string>();
    for await (const e of readArchive(archiveOf()())) if (e.type === "tableStart") seen.add(e.table);
    expect(seen.has("audit_log")).toBe(false);
    expect(seen.has("tickets")).toBe(true);
  });

  it("compares as identical when nothing changed, ignoring what pollers rewrite constantly", async () => {
    await backup();
    // A monitor's live status is volatile: the worker rewrites it every few seconds.
    await db.update(schema.monitors).set({ status: "down", consecutiveFails: 3, lastLatencyMs: 99 }).where(eq(schema.monitors.id, ids.monitor));
    const { report } = await compare();
    expect(report.totals).toMatchObject({ added: 0, removed: 0, changed: 0 });
    expect(report.groups).toEqual([]);
    expect(report.compatibility.ok).toBe(true);
    expect(report.secretMismatch).toBe(false);
  });

  it("reports what changed since: rows added, removed and changed, with readable labels and secrets hidden", async () => {
    await backup();
    // Changed since the backup.
    await db.update(schema.tickets).set({ title: "Printer jam (fixed)", status: "closed" }).where(eq(schema.tickets.id, ids.ticketA));
    await db.update(schema.users).set({ email: "ada@new.example.org" }).where(eq(schema.users.id, ids.admin));
    await db.update(schema.settings).set({ value: "enc:v1:rotated" }).where(eq(schema.settings.key, "smtp.password"));
    await db.update(schema.credentials).set({ passwordHash: "argon-hash-2" }).where(eq(schema.credentials.userId, ids.admin));
    // Removed since the backup.
    await db.delete(schema.tickets).where(eq(schema.tickets.id, ids.ticketB));
    // Added since the backup.
    await db.insert(schema.tickets).values({ title: "Projector bulb", createdByUserId: ids.member });
    await db.insert(schema.notes).values({ id: ids.noteOwned, ownerUserId: ids.member, title: "Shopping list" });
    await store.put("attachments/note/three.png", png(30), "image/png");
    await store.remove([KEY2]);

    const { report } = await compare(undefined, ids.admin);
    const tickets = table(report, "tickets")!;
    expect(tickets).toMatchObject({ backupRows: 2, currentRows: 2, added: 1, removed: 1, changed: 1 });
    expect(tickets.samples.added[0]!.label).toContain("Wifi down");
    expect(tickets.samples.removed[0]!.label).toContain("Projector bulb");
    const change = tickets.samples.changed[0]!;
    expect(change.label).toContain("Printer jam (fixed)");
    expect(change.changes.find((c) => c.column === "title")).toMatchObject({ current: "Printer jam (fixed)", backup: "Printer jam" });
    expect(change.changes.find((c) => c.column === "status")).toMatchObject({ current: "closed", backup: "open" });

    expect(table(report, "notes")).toMatchObject({ added: 0, removed: 1 });
    expect(table(report, "users")!.samples.changed[0]!.changes[0]).toMatchObject({ column: "email", backup: "ada@example.org" });

    // Secrets are reported as changed, never shown.
    const creds = table(report, "credentials")!.samples.changed[0]!.changes[0]!;
    expect(creds).toMatchObject({ column: "password_hash", secret: true, current: null, backup: null });
    const settings = table(report, "settings")!.samples.changed[0]!;
    expect(settings.label).toContain("smtp.password");
    expect(settings.changes[0]).toMatchObject({ column: "value", secret: true, current: null, backup: null });

    expect(report.files).toMatchObject({ added: 1, removed: 1 });
    expect(report.files!.samples.added).toEqual([KEY2]);
    expect(report.files!.samples.removed).toEqual(["attachments/note/three.png"]);
    expect(report.you).toMatchObject({ status: "changed" });
    expect(report.totals.changed).toBeGreaterThanOrEqual(4);
  });

  it("warns when the backup was made under a different AUTH_SECRET and refuses a backup from a newer version", async () => {
    await backup();
    expect((await compare("another-secret")).report.secretMismatch).toBe(true);
    expect((await compare("another-secret")).report.compatibility.warnings.join(" ")).toMatch(/AUTH_SECRET/);

    // A backup claiming more migrations than this database has came from a newer release.
    await storeBackup({ db, store }, "backups/newer.tar.gz", options);
    const now = (await appliedMigrations(db)) ?? 0;
    const original = store.objects.get("backups/newer.tar.gz")!;
    void original;
    const out = await computeDiff(
      { db, store },
      {
        backup: { id: "n", name: "n", createdAt: new Date().toISOString() },
        archive: () => rewriteManifest(archiveOf("backups/newer.tar.gz")(), (m) => ({ ...m, schemaMigrations: now + 5 })),
        secretFingerprint: "fp-a",
      },
    );
    expect(out.report.compatibility.ok).toBe(false);
    expect(out.report.compatibility.errors.join(" ")).toMatch(/newer version/);
  });

  it("restores the data exactly as it was, and puts a live monitor's status back untouched", async () => {
    await backup();
    const before = await snapshot();

    await db.update(schema.tickets).set({ title: "Changed", status: "closed" }).where(eq(schema.tickets.id, ids.ticketA));
    await db.delete(schema.tickets).where(eq(schema.tickets.id, ids.ticketB));
    await db.insert(schema.tickets).values({ title: "Added later", createdByUserId: ids.member });
    await db.update(schema.credentials).set({ passwordHash: "argon-hash-2" }).where(eq(schema.credentials.userId, ids.admin));
    await db.delete(schema.users).where(eq(schema.users.id, ids.member)); // cascades to their tickets
    await db.update(schema.monitors).set({ status: "down", consecutiveFails: 9 }).where(eq(schema.monitors.id, ids.monitor));
    await run(sql`INSERT INTO audit_log (action, resource_type) VALUES ('after.backup', 'x')`);

    const out = await compare();
    expect(out.report.compatibility.ok).toBe(true);
    const counts = await applyRestore({ db }, out, { archive: archiveOf() });
    expect(counts.rowsAdded + counts.rowsRemoved + counts.rowsChanged).toBeGreaterThan(0);

    const after = await snapshot();
    for (const [name, rows] of Object.entries(before)) {
      if (name === "monitors") continue; // compared below: its live columns are left alone
      expect(after[name], name).toEqual(rows);
    }
    // The monitor row is back, and its status is still what the poller last wrote.
    const [m] = await db.select().from(schema.monitors).where(eq(schema.monitors.id, ids.monitor));
    expect(m).toMatchObject({ name: "Website", status: "down", consecutiveFails: 9 });
    // The audit log is never rewound.
    const audit = await db.execute(sql`SELECT count(*) AS n FROM audit_log WHERE action = 'after.backup'`);
    expect(Number((audit.rows[0] as { n: unknown }).n)).toBe(1);
    // A second comparison finds nothing left to do.
    const again = await compare();
    expect(again.report.totals).toMatchObject({ added: 0, removed: 0, changed: 0 });
  });

  it("restores a tree of folders and pages that point at each other, in the right order", async () => {
    await backup();
    await db.delete(schema.wikiPages);
    await db.delete(schema.wikiFolders);
    const out = await compare();
    expect(table(out.report, "wiki_folders")).toMatchObject({ added: 3, removed: 0 });
    await applyRestore({ db }, out, { archive: archiveOf() });
    const folders = await db.select().from(schema.wikiFolders);
    expect(folders.find((f) => f.id === ids.folderGrand)!.parentFolderId).toBe(ids.folderChild);
    const pages = await db.select().from(schema.wikiPages);
    expect(pages.find((p) => p.id === ids.pageChild)!.parentId).toBe(ids.pageParent);
  });

  it("restores into an empty database, as on a fresh install, and keeps ticket numbers from repeating", async () => {
    const tickets = await db.select().from(schema.tickets);
    const highest = Math.max(...tickets.map((t) => t.number));
    await backup();
    await wipe();
    const out = await compare();
    await applyRestore({ db }, out, { archive: archiveOf() });
    expect((await db.select().from(schema.users)).length).toBe(2);
    expect((await db.select().from(schema.attachments)).length).toBe(2);
    const [fresh] = await db.insert(schema.tickets).values({ title: "New after restore", createdByUserId: ids.member }).returning();
    expect(fresh!.number).toBeGreaterThan(highest);
  });

  it("all or nothing: a failure partway leaves the database as it was", async () => {
    await backup();
    await db.delete(schema.users).where(eq(schema.users.id, ids.member)); // and with them their tickets
    await db.insert(schema.tickets).values({ title: "Added later", createdByUserId: ids.admin });
    const out = await compare();
    expect(out.plans.get("tickets")!.removedKeys).toHaveLength(1);
    // After the plan is made, somebody takes the e-mail address the restore must give back to Mo.
    await db.insert(schema.users).values({ id: id(3), name: "Squatter", email: "mo@example.org" });
    const mid = await snapshot();
    await expect(applyRestore({ db }, out, { archive: archiveOf() })).rejects.toThrow(/unique|duplicate/i);
    // The deletes that ran before the failure were rolled back with it.
    expect(await snapshot()).toEqual(mid);
    expect((await db.select().from(schema.tickets)).some((t) => t.title === "Added later")).toBe(true);
  });

  it("leaves files that are already in storage alone", async () => {
    await backup();
    const out = await compare();
    expect(out.report.files).toMatchObject({ added: 0, removed: 0 });
    expect(out.storageFiles!.get(KEY1)).toBe(png(10).length);
  });

  it("every table that has a sequence default is in the registry", () => {
    const withSequences = Object.values(TABLE_REGISTRY).flatMap((t) => t.sequences ?? []).map((s) => s.sequence);
    expect(withSequences).toContain("tickets_number_seq");
  });
});

/** The same archive with its manifest rewritten, to pretend it came from another version. */
async function* rewriteManifest(source: AsyncIterable<Buffer>, edit: (m: Record<string, unknown>) => Record<string, unknown>): AsyncGenerator<Buffer> {
  const { readTar, TarWriter } = await import("../src/backup/tar");
  const { PassThrough } = await import("node:stream");
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on("data", (c: Buffer) => chunks.push(c));
  const w = new TarWriter(out);
  for await (const entry of readTar(source)) {
    if (entry.name === "manifest.json") {
      await w.addBuffer("manifest.json", Buffer.from(JSON.stringify(edit(JSON.parse((await entry.buffer()).toString())))));
    } else {
      await w.addStream(entry.name, entry.size, entry.body());
    }
  }
  await w.finish();
  out.end();
  yield Buffer.concat(chunks);
}
