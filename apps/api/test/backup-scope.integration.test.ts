import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import * as schema from "../src/db/schema";
import type { Db } from "../src/db/db.module";
import { backedUpTables } from "../src/backup/backup-schema";
import { storeBackup } from "../src/backup/backup-writer";
import { gunzipped } from "../src/backup/archive";
import { computeDiff, type DiffOutput } from "../src/backup/backup-diff";
import { applyRestore } from "../src/backup/backup-restore";
import { tablesInSections } from "../src/backup/table-registry";
import { MemoryObjectStore } from "./helpers/memory-object-store";

/**
 * A restore limited to some sections (wiki, users ...), against a real database. Skipped unless
 * TEST_DATABASE_URL points at a migrated scratch database (every backed-up table is emptied first).
 * Run it on CockroachDB and on YugabyteDB:
 *
 *   TEST_DATABASE_URL=postgresql://root@host:26257/scratch?sslmode=disable \
 *     pnpm --filter @church/api exec vitest run test/backup-scope.integration.test.ts
 */
const url = process.env.TEST_DATABASE_URL;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const U = { ada: id(1), mo: id(2), zed: id(3), yan: id(4) };
const G = { admin: id(10) };
const T = { one: id(20), two: id(21), zed: id(22) };
const F = { root: id(30), child: id(31), live: id(32) };
const P = { one: id(40), two: id(41), twoChild: id(42), live: id(43) };
const N = { ada: id(50), zed: id(51) };

describe.skipIf(!url)("restoring only some sections, against a real database", () => {
  let pool: Pool;
  let db: Db;
  let store: MemoryObjectStore;
  const options = { id: "bk-scope", name: "Scope test", includeFiles: true, createdBy: null, appVersion: "test", secretFingerprint: "fp" };

  const run = async (q: ReturnType<typeof sql>) => void (await db.execute(q));

  async function wipe(): Promise<void> {
    for (const t of [...backedUpTables()].reverse()) await run(sql`DELETE FROM ${sql.identifier(t.name)}`);
  }

  async function seed(): Promise<void> {
    await db.insert(schema.users).values([
      { id: U.ada, name: "Ada Admin", email: "ada@example.org" },
      { id: U.mo, name: "Mo Member", email: "mo@example.org" },
    ]);
    await db.insert(schema.groups).values({ id: G.admin, name: "admin" });
    await db.insert(schema.groupMemberships).values({ groupId: G.admin, userId: U.ada });
    await db.insert(schema.tickets).values([
      { id: T.one, title: "Printer jam", description: "Second floor", createdByUserId: U.mo },
      { id: T.two, title: "Wifi down", description: "Hall", createdByUserId: U.ada },
    ]);
    await db.insert(schema.wikiFolders).values([
      { id: F.root, name: "Root" },
      { id: F.child, name: "Child", parentFolderId: F.root },
    ]);
    await db.insert(schema.wikiPages).values([
      { id: P.one, title: "Welcome", body: "hello", ownerUserId: U.ada, parentFolderId: F.root },
      { id: P.two, title: "Mo's guide", body: "by mo", ownerUserId: U.mo, parentFolderId: F.child },
      { id: P.twoChild, title: "Mo's guide, part 2", body: "more", ownerUserId: U.ada, parentId: P.two, parentFolderId: F.child },
    ]);
    await db.insert(schema.notes).values({ id: N.ada, ownerUserId: U.ada, title: "Shopping list" });
    await db.insert(schema.settings).values({ key: "site.name", value: "Grace Church" });
  }

  async function backup(): Promise<void> {
    await storeBackup({ db, store }, "backups/bk-scope.tar.gz", options);
  }
  const archive = () =>
    (async function* () {
      yield* gunzipped(await store.get("backups/bk-scope.tar.gz"));
    })();

  async function plan(sections: string[] | null, files = false): Promise<DiffOutput> {
    return computeDiff(
      { db, store },
      {
        backup: { id: "bk-scope", name: "Scope test", createdAt: new Date().toISOString() },
        archive,
        secretFingerprint: "fp",
        userId: U.ada,
        scope: sections ? { sections, tables: tablesInSections(sections), files } : null,
      },
    );
  }
  const restore = async (out: DiffOutput) => applyRestore({ db }, out, { archive });

  const rows = async <R = Record<string, unknown>>(q: ReturnType<typeof sql>) => (await db.execute(q)).rows as R[];
  const count = async (table: string, where = sql`TRUE`) =>
    Number((await rows<{ n: string | number }>(sql`SELECT count(*) AS n FROM ${sql.identifier(table)} WHERE ${where}`))[0]!.n);
  const note = (notes: Array<{ table: string; count: number; reason: string }>, table: string) => notes.find((n) => n.table === table);
  const notesFor = (notes: Array<{ table: string; count: number; reason: string }>, table: string) => notes.filter((n) => n.table === table);

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
    await seed();
  }, 120_000);

  it("restoring the wiki puts back the wiki and leaves tickets, notes, users and settings exactly as they are", async () => {
    await backup();
    // Wiki: edited, deleted, added since.
    await db.update(schema.wikiPages).set({ title: "Welcome (vandalised)" }).where(eq(schema.wikiPages.id, P.one));
    await db.insert(schema.wikiFolders).values({ id: F.live, name: "Made later" });
    await db.insert(schema.wikiPages).values({ id: P.live, title: "Made later", body: "x", ownerUserId: U.ada, parentFolderId: F.live });
    // Everything else: changed too, and that must stay.
    await db.update(schema.tickets).set({ title: "Printer jam (fixed)", status: "closed" }).where(eq(schema.tickets.id, T.one));
    await db.update(schema.notes).set({ title: "Shopping list v2" }).where(eq(schema.notes.id, N.ada));
    await db.update(schema.settings).set({ value: "Grace Chapel" }).where(eq(schema.settings.key, "site.name"));
    await db.update(schema.users).set({ name: "Ada Administrator" }).where(eq(schema.users.id, U.ada));

    const out = await plan(["wiki"]);
    expect(out.report.scope).toEqual({ partial: true, sections: ["wiki"] });
    const tables = out.report.groups.flatMap((g) => g.tables.map((t) => t.table));
    expect(tables.every((t) => ["wiki_pages", "wiki_folders", "wiki_page_acl", "wiki_revisions"].includes(t))).toBe(true);
    expect(out.report.files).toBeNull();
    expect(out.filesInScope).toBe(false);
    expect(out.fileIndex).toBeNull();
    expect(out.report.you).toBeNull(); // users are not part of this restore
    expect(out.plans.has("tickets")).toBe(false);
    await restore(out);

    expect((await rows<{ title: string }>(sql`SELECT title FROM wiki_pages WHERE id = ${P.one}`))[0]!.title).toBe("Welcome");
    expect(await count("wiki_pages", sql`id = ${P.live}`)).toBe(0);
    expect(await count("wiki_folders", sql`id = ${F.live}`)).toBe(0);
    // Not part of the restore: untouched.
    expect((await rows<{ title: string }>(sql`SELECT title FROM tickets WHERE id = ${T.one}`))[0]!.title).toBe("Printer jam (fixed)");
    expect((await rows<{ title: string }>(sql`SELECT title FROM notes WHERE id = ${N.ada}`))[0]!.title).toBe("Shopping list v2");
    expect((await rows<{ value: string }>(sql`SELECT value FROM settings WHERE key = 'site.name'`))[0]!.value).toBe("Grace Chapel");
    expect((await rows<{ name: string }>(sql`SELECT name FROM users WHERE id = ${U.ada}`))[0]!.name).toBe("Ada Administrator");
  });

  it("skips what depends on a user that is gone and was not included, and says so", async () => {
    await backup();
    // Mo no longer exists; his guide (and the page nested under it) is in the backup.
    await db.update(schema.tickets).set({ createdByUserId: U.ada }).where(eq(schema.tickets.id, T.one));
    await db.delete(schema.wikiPages).where(eq(schema.wikiPages.id, P.twoChild));
    await db.delete(schema.wikiPages).where(eq(schema.wikiPages.id, P.two));
    await db.delete(schema.users).where(eq(schema.users.id, U.mo));
    await db.update(schema.wikiPages).set({ title: "Welcome (vandalised)" }).where(eq(schema.wikiPages.id, P.one));

    const out = await plan(["wiki"]);
    // Two lines, two reasons: the guide (its author is gone), and the part nested under it.
    const lines = notesFor(out.report.skipped, "Wiki pages");
    expect(lines.reduce((n, l) => n + l.count, 0)).toBe(2);
    expect(lines.some((l) => /People and access/.test(l.reason))).toBe(true);
    expect(lines.some((l) => /could not be put back/.test(l.reason))).toBe(true);
    expect(out.skippedRows).toBe(2);
    expect(out.report.compatibility.ok).toBe(true);
    await restore(out);

    expect((await rows<{ title: string }>(sql`SELECT title FROM wiki_pages WHERE id = ${P.one}`))[0]!.title).toBe("Welcome");
    expect(await count("wiki_pages", sql`id IN (${P.two}, ${P.twoChild})`)).toBe(0);
    expect(await count("users", sql`id = ${U.mo}`)).toBe(0); // not resurrected
  });

  it("includes People and access: the same restore then brings the user and the pages back", async () => {
    await backup();
    await db.update(schema.tickets).set({ createdByUserId: U.ada }).where(eq(schema.tickets.id, T.one));
    await db.delete(schema.wikiPages).where(eq(schema.wikiPages.id, P.twoChild));
    await db.delete(schema.wikiPages).where(eq(schema.wikiPages.id, P.two));
    await db.delete(schema.users).where(eq(schema.users.id, U.mo));

    const out = await plan(["people-and-access", "wiki"]);
    expect(out.report.skipped).toEqual([]);
    await restore(out);
    expect(await count("users", sql`id = ${U.mo}`)).toBe(1);
    expect(await count("wiki_pages", sql`id IN (${P.two}, ${P.twoChild})`)).toBe(2);
    // tickets were not included: Mo's ticket still says Ada made it
    expect((await rows<{ created_by_user_id: string }>(sql`SELECT created_by_user_id FROM tickets WHERE id = ${T.one}`))[0]!.created_by_user_id).toBe(U.ada);
  });

  it("keeps a user that something outside the restore still uses, and removes one nothing uses", async () => {
    await backup();
    // Two people joined since the backup; a ticket and a note (not part of the restore) belong to Zed.
    await db.insert(schema.users).values([
      { id: U.zed, name: "Zed", email: "zed@example.org" },
      { id: U.yan, name: "Yan", email: "yan@example.org" },
    ]);
    await db.insert(schema.tickets).values({ id: T.zed, title: "Zed's ticket", description: "d", createdByUserId: U.zed });
    await db.insert(schema.notes).values({ id: N.zed, ownerUserId: U.zed, title: "Zed's note" });
    await db.update(schema.users).set({ name: "Mo (renamed)" }).where(eq(schema.users.id, U.mo));

    const out = await plan(["people-and-access"]);
    const kept = note(out.report.kept, "Users");
    expect(kept?.count).toBe(1);
    expect(kept?.reason).toMatch(/tickets/);
    expect(kept?.reason).toMatch(/notes/);
    await restore(out);

    expect(await count("users", sql`id = ${U.zed}`)).toBe(1); // kept
    expect(await count("users", sql`id = ${U.yan}`)).toBe(0); // nothing uses Yan
    expect((await rows<{ name: string }>(sql`SELECT name FROM users WHERE id = ${U.mo}`))[0]!.name).toBe("Mo Member");
    expect(await count("tickets", sql`id = ${T.zed}`)).toBe(1); // nothing outside the restore was deleted or cascaded away
    expect(await count("notes", sql`id = ${N.zed}`)).toBe(1);
  });

  it("restoring tickets does not bring back a ticket whose creator is gone, and does not touch the rest", async () => {
    await backup();
    await db.delete(schema.tickets).where(eq(schema.tickets.id, T.one)); // in the backup, made by Mo
    await db.update(schema.tickets).set({ title: "Wifi down (edited)" }).where(eq(schema.tickets.id, T.two));
    await db.delete(schema.wikiPages).where(eq(schema.wikiPages.id, P.twoChild));
    await db.delete(schema.wikiPages).where(eq(schema.wikiPages.id, P.two));
    await db.delete(schema.users).where(eq(schema.users.id, U.mo));

    const out = await plan(["helpdesk"]);
    expect(note(out.report.skipped, "Tickets")?.count).toBe(1);
    await restore(out);
    expect(await count("tickets", sql`id = ${T.one}`)).toBe(0); // skipped: Mo is gone
    expect((await rows<{ title: string }>(sql`SELECT title FROM tickets WHERE id = ${T.two}`))[0]!.title).toBe("Wifi down");
    expect(await count("wiki_pages")).toBe(1); // the wiki, deleted above, was not restored
  });

  it("a restore of every section is the ordinary full rollback", async () => {
    await backup();
    await db.update(schema.tickets).set({ title: "edited" }).where(eq(schema.tickets.id, T.one));
    await db.delete(schema.wikiPages).where(eq(schema.wikiPages.id, P.twoChild));
    const out = await plan(null);
    expect(out.report.scope).toEqual({ partial: false, sections: [] });
    expect(out.report.skipped).toEqual([]);
    expect(out.report.kept).toEqual([]);
    expect(out.filesInScope).toBe(true);
    await restore(out);
    expect((await rows<{ title: string }>(sql`SELECT title FROM tickets WHERE id = ${T.one}`))[0]!.title).toBe("Printer jam");
    expect(await count("wiki_pages")).toBe(3);
  });

  it("files are part of a restore only when the Files section is chosen", async () => {
    await store.put("attachments/note/one.png", Buffer.from("x"), "image/png");
    await db.insert(schema.attachments).values({ id: id(60), parentType: "note", parentId: id(99), filename: "one.png", contentType: "image/png", sizeBytes: 1, storageKey: "attachments/note/one.png" });
    await backup();
    const withoutFiles = await plan(["wiki"], false);
    expect(withoutFiles.filesInScope).toBe(false);
    expect(withoutFiles.report.files).toBeNull();
    const withFiles = await plan(["files"], true);
    expect(withFiles.filesInScope).toBe(true);
    expect(withFiles.fileIndex?.length).toBe(1);
    expect(withFiles.report.files).not.toBeNull();
  });
});
