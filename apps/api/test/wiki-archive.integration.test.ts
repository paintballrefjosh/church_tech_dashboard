import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { WikiService } from "../src/wiki/wiki.service";
import { WikiReview } from "../src/wiki/wiki-review";
import type { AuthenticatedUser } from "../src/auth/current-user.decorator";
import * as schema from "../src/db/schema";

/**
 * Archiving a wiki page against a real database (see db-stores.integration.test.ts for the setup): who may do it, that it is not an
 * edit, and where an archived page shows (the tree, the list, the review screen and the review reminder). It empties the wiki
 * tables, so never point it at a database you care about. Run on CockroachDB and YugabyteDB, one integration file at a time.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("archiving wiki pages against a real database", () => {
  let pool: Pool;
  let wiki: WikiService;
  let review: WikiReview;
  let sent: string[] = [];
  let owner = "";
  let editor = "";
  let stranger = "";
  let team = "";
  const q = (text: string, params: unknown[] = []) => pool.query(text, params);

  const person = (id: string, permissions: string[]): AuthenticatedUser =>
    ({ id, email: `${id}@test.local`, name: id, permissions }) as unknown as AuthenticatedUser;
  const base = ["wiki:read:own", "wiki:write:own"];

  const addPage = async (o: { title: string; body?: string; owner?: string; visibility?: string; ageDays?: number; parentId?: string | null }) =>
    (
      await q(
        `INSERT INTO wiki_pages (title, body, owner_user_id, visibility, parent_id, updated_at)
         VALUES ($1, $2, $3, $4, $5, now() - ($6 || ' days')::interval) RETURNING id`,
        [o.title, o.body ?? "", o.owner ?? owner, o.visibility ?? "public", o.parentId ?? null, String(o.ageDays ?? 0)],
      )
    ).rows[0].id as string;
  const row = async (id: string) =>
    (
      await q(
        `SELECT extract(epoch FROM updated_at) * 1000 AS u, extract(epoch FROM archived_at) * 1000 AS a, archived_by AS ab FROM wiki_pages WHERE id = $1`,
        [id],
      )
    ).rows[0] as { u: string; a: string | null; ab: string | null };
  const revisionCount = async (id: string) => Number((await q(`SELECT count(*) AS c FROM wiki_revisions WHERE page_id = $1`, [id])).rows[0].c);
  const titles = (pages: Array<{ title: string }>) => pages.map((p) => p.title);

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 5 });
    const db = drizzle(pool, { schema });
    await q(`DELETE FROM wiki_pages`);
    await q(`DELETE FROM group_memberships WHERE group_id IN (SELECT id FROM groups WHERE name LIKE 'Wiki Test%')`);
    await q(`DELETE FROM groups WHERE name LIKE 'Wiki Test%'`);
    await q(`DELETE FROM users WHERE email LIKE 'wa-%@test.local'`);
    const mk = async (n: string) => (await q(`INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`, [`wa-${n}@test.local`, n])).rows[0].id as string;
    owner = await mk("owner");
    editor = await mk("editor");
    stranger = await mk("stranger");
    team = (await q(`INSERT INTO groups (name) VALUES ('Wiki Test editors') RETURNING id`)).rows[0].id as string;
    await q(`INSERT INTO group_memberships (group_id, user_id) VALUES ($1, $2)`, [team, editor]);

    const settings = { get: async () => undefined };
    const notifications = {
      createMany: async (inputs: Array<{ title: string }>) => {
        for (const i of inputs) sent.push(i.title);
      },
    };
    const none = { changed: () => undefined, record: async () => undefined, notify: async () => undefined, assertExists: async () => undefined };
    wiki = new WikiService(db as never, none as never, none as never, none as never, none as never, none as never, settings as never);
    review = new WikiReview(db as never, { register: () => undefined } as never, settings as never, notifications as never);
  });
  afterAll(async () => {
    await q(`DELETE FROM wiki_pages`);
    await q(`DELETE FROM group_memberships WHERE group_id IN (SELECT id FROM groups WHERE name LIKE 'Wiki Test%')`);
    await q(`DELETE FROM groups WHERE name LIKE 'Wiki Test%'`);
    await q(`DELETE FROM users WHERE email LIKE 'wa-%@test.local'`);
    await pool?.end();
  });
  beforeEach(async () => {
    await q(`DELETE FROM wiki_pages`);
    sent = [];
  });

  describe("who may archive", () => {
    it("lets the owner, an editing group and a Wiki admin, and refuses someone who can only read", async () => {
      const mine = await addPage({ title: "Mine" });
      await wiki.archive(person(owner, base), mine);
      expect((await row(mine)).ab).toBe(owner);

      const shared = await addPage({ title: "Shared" });
      await q(`INSERT INTO wiki_page_acl (page_id, group_id, can_edit) VALUES ($1, $2, true)`, [shared, team]);
      await wiki.archive(person(editor, base), shared);
      expect((await row(shared)).ab).toBe(editor);

      const other = await addPage({ title: "Other" });
      await wiki.archive(person(stranger, ["wiki:admin", ...base]), other);
      expect((await row(other)).a).not.toBeNull();

      const readOnly = await addPage({ title: "Read only" });
      await expect(wiki.archive(person(stranger, base), readOnly)).rejects.toThrow(/cannot edit/i);
      await expect(wiki.unarchive(person(stranger, base), readOnly)).rejects.toThrow(/cannot edit/i);
      expect((await row(readOnly)).a).toBeNull();
    });

    it("answers 404, not 403, for a restricted page the person cannot read", async () => {
      const secret = await addPage({ title: "Hidden", visibility: "group" });
      await expect(wiki.archive(person(stranger, base), secret)).rejects.toThrow(/not found/i);
    });
  });

  describe("it is not an edit", () => {
    it("leaves updated_at alone and makes no revision, both ways", async () => {
      const id = await addPage({ title: "Old page", ageDays: 30 });
      const before = await row(id);
      await wiki.archive(person(owner, base), id);
      expect((await row(id)).u).toBe(before.u);
      await wiki.unarchive(person(owner, base), id);
      expect((await row(id)).u).toBe(before.u);
      expect(await revisionCount(id)).toBe(0);
    });

    it("keeps the first date and archiver when it is archived twice, and clears both on restore", async () => {
      const id = await addPage({ title: "Twice" });
      await wiki.archive(person(owner, base), id);
      const first = await row(id);
      await wiki.archive(person(stranger, ["wiki:admin", ...base]), id);
      expect(await row(id)).toEqual(first);

      await wiki.unarchive(person(owner, base), id);
      expect(await row(id)).toMatchObject({ a: null, ab: null });
      await wiki.unarchive(person(owner, base), id);
      expect((await row(id)).a).toBeNull();
    });

    it("tells the page view who archived it", async () => {
      const id = await addPage({ title: "Seen" });
      await wiki.archive(person(owner, base), id);
      const out = await wiki.getWithAcl(person(owner, base), id);
      expect(out.page.archivedAt).toBeInstanceOf(Date);
      expect(out.archivedBy).toMatchObject({ id: owner, name: "owner" });
      await wiki.unarchive(person(owner, base), id);
      expect((await wiki.getWithAcl(person(owner, base), id)).archivedBy).toBeNull();
    });

    it("is still readable and editable by address", async () => {
      const id = await addPage({ title: "Put away", body: "still here" });
      await wiki.archive(person(owner, base), id);
      const out = await wiki.getWithAcl(person(stranger, base), id);
      expect(out.page.body).toBe("still here");
      expect(out.canEdit).toBe(false);
      expect((await wiki.getWithAcl(person(owner, base), id)).canEdit).toBe(true);
    });
  });

  describe("the list", () => {
    it("leaves archived pages out when browsing", async () => {
      await addPage({ title: "Live" });
      const gone = await addPage({ title: "Gone" });
      await wiki.archive(person(owner, base), gone);
      expect(titles(await wiki.list(person(owner, base), { limit: 100 }))).toEqual(["Live"]);
    });

    it("puts archived pages after the rest when searching, however new they are", async () => {
      const newest = await addPage({ title: "Backup plan archived", ageDays: 0 });
      await addPage({ title: "Backup plan current", ageDays: 5 });
      await addPage({ title: "Backup plan older", ageDays: 90 });
      await wiki.archive(person(owner, base), newest);
      const out = await wiki.list(person(owner, base), { q: "backup plan", limit: 100 });
      expect(titles(out)).toEqual(["Backup plan current", "Backup plan older", "Backup plan archived"]);
      expect(out.map((p) => p.archivedAt !== null)).toEqual([false, false, true]);
    });

    it("cuts archived pages before live ones when the limit bites", async () => {
      const a = await addPage({ title: "Rota archived", ageDays: 0 });
      await addPage({ title: "Rota one", ageDays: 1 });
      await addPage({ title: "Rota two", ageDays: 2 });
      await wiki.archive(person(owner, base), a);
      expect(titles(await wiki.list(person(owner, base), { q: "rota", limit: 2 }))).toEqual(["Rota one", "Rota two"]);
    });

    it("still keeps a restricted archived page from someone who cannot read it", async () => {
      const id = await addPage({ title: "Secret rota", visibility: "group" });
      await wiki.archive(person(owner, base), id);
      expect(await wiki.list(person(stranger, base), { q: "rota", limit: 100 })).toEqual([]);
      expect(titles(await wiki.list(person(owner, base), { q: "rota", limit: 100 }))).toEqual(["Secret rota"]);
    });
  });

  describe("the tree (the menu and every page picker)", () => {
    it("leaves archived pages out, and returns them flagged when asked", async () => {
      await addPage({ title: "Live" });
      const gone = await addPage({ title: "Gone" });
      await wiki.archive(person(owner, base), gone);

      const menu = await wiki.tree(person(owner, base));
      expect(menu.filter((n) => n.kind === "page").map((n) => (n.kind === "page" ? n.title : ""))).toEqual(["Live"]);

      const all = await wiki.tree(person(owner, base), { includeArchived: true });
      const flagged = all.filter((n) => n.kind === "page" && n.archived);
      expect(flagged).toHaveLength(1);
      expect(flagged[0]).toMatchObject({ id: gone, title: "Gone", archived: true });
      expect(all.find((n) => n.kind === "page" && n.title === "Live")).not.toHaveProperty("archived");
    });

    it("keeps a page whose parent was archived, still naming that parent", async () => {
      const parent = await addPage({ title: "Parent" });
      const child = await addPage({ title: "Child", parentId: parent });
      await wiki.archive(person(owner, base), parent);
      const menu = await wiki.tree(person(owner, base));
      // Folders may exist in the database (other test files, the seed): only the pages are under test.
      expect(menu.filter((n) => n.kind === "page")).toEqual([expect.objectContaining({ id: child, parentId: parent })]);
    });
  });

  describe("review", () => {
    it("does not list an archived page as due, or remind its owner", async () => {
      // Just past the 180-day default and inside the 3-day notice window, so a live page gets a message, not a silent flag.
      const stale = await addPage({ title: "Stale and archived", ageDays: 181 });
      await addPage({ title: "Stale and live", ageDays: 181 });
      await wiki.archive(person(owner, base), stale);

      const due = await wiki.reviewList(person(owner, base), { scope: "all", limit: 100 });
      expect(due.items.map((i) => i.title)).toEqual(["Stale and live"]);

      await review.run();
      expect(sent.join(" ")).toContain("Stale and live");
      expect(sent.join(" ")).not.toContain("Stale and archived");
      const claimed = await q(`SELECT review_notified_at FROM wiki_pages WHERE id = $1`, [stale]);
      expect(claimed.rows[0].review_notified_at).toBeNull();
    });
  });
});
