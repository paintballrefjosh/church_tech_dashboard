import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { WIKI_REVIEW_DAYS_KEY } from "@church/shared";
import { WikiService } from "../src/wiki/wiki.service";
import { WikiReview } from "../src/wiki/wiki-review";
import { WikiTemplatesService } from "../src/wiki/wiki-templates.service";
import type { AuthenticatedUser } from "../src/auth/current-user.decorator";
import * as schema from "../src/db/schema";

/**
 * Backlinks, "needs review", confirming a page, the review reminder job and templates against a real database (see
 * db-stores.integration.test.ts for the setup). It empties the wiki tables, so never point it at a database you care about.
 * Run on CockroachDB and YugabyteDB.
 */
const url = process.env.TEST_DATABASE_URL;
const DAY = 86_400_000;

interface Sent {
  recipients: string[];
  kind: string;
  title: string;
  body: string;
  link: string;
}

describe.skipIf(!url)("wiki backlinks, review and templates against a real database", () => {
  let pool: Pool;
  let wiki: WikiService;
  let review: WikiReview;
  let templates: WikiTemplatesService;
  let values: Record<string, unknown> = {};
  let sent: Sent[] = [];
  let owner = "";
  let editor = "";
  let reader = "";
  let stranger = "";
  let team = "";
  const q = (text: string, params: unknown[] = []) => pool.query(text, params);

  const person = (id: string, permissions: string[]): AuthenticatedUser =>
    ({ id, email: `${id}@test.local`, name: id, permissions }) as unknown as AuthenticatedUser;
  const base = ["wiki:read:own", "wiki:write:own"];

  const addPage = async (o: { title: string; body?: string; owner?: string; visibility?: string; daysSinceEdit?: number; reviewedDaysAgo?: number | null; interval?: number | null }) =>
    (
      await q(
        `INSERT INTO wiki_pages (title, body, owner_user_id, visibility, updated_at, last_reviewed_at, review_interval_days)
         VALUES ($1, $2, $3, $4, now() - ($5 || ' days')::interval,
                 CASE WHEN $6::text IS NULL THEN NULL ELSE now() - ($6 || ' days')::interval END, $7) RETURNING id`,
        [
          o.title,
          o.body ?? "",
          o.owner ?? owner,
          o.visibility ?? "public",
          String(o.daysSinceEdit ?? 0),
          o.reviewedDaysAgo == null ? null : String(o.reviewedDaysAgo),
          o.interval ?? null,
        ],
      )
    ).rows[0].id as string;
  // Raw queries return timestamps as strings (drizzle() replaces pg's parsers) and integers as strings on CockroachDB.
  const state = async (id: string) => {
    const r = (
      await q(
        `SELECT extract(epoch FROM updated_at) * 1000 AS u, extract(epoch FROM last_reviewed_at) * 1000 AS r, last_reviewed_by AS rb,
                extract(epoch FROM review_notified_at) * 1000 AS n, review_interval_days AS i FROM wiki_pages WHERE id = $1`,
        [id],
      )
    ).rows[0] as { u: string; r: string | null; rb: string | null; n: string | null; i: string | null };
    return { u: Number(r.u), r: r.r === null ? null : Number(r.r), rb: r.rb, n: r.n === null ? null : Number(r.n), i: r.i === null ? null : Number(r.i) };
  };
  const revisionCount = async (id: string) => Number((await q(`SELECT count(*) AS c FROM wiki_revisions WHERE page_id = $1`, [id])).rows[0].c);

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 5 });
    const db = drizzle(pool, { schema });
    await q(`DELETE FROM wiki_templates`);
    await q(`DELETE FROM wiki_pages`);
    await q(`DELETE FROM group_memberships WHERE group_id IN (SELECT id FROM groups WHERE name LIKE 'Wiki Test%')`);
    await q(`DELETE FROM groups WHERE name LIKE 'Wiki Test%'`);
    await q(`DELETE FROM users WHERE email LIKE 'wk-%@test.local'`);
    const mk = async (n: string) => (await q(`INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`, [`wk-${n}@test.local`, n])).rows[0].id as string;
    owner = await mk("owner");
    editor = await mk("editor");
    reader = await mk("reader");
    stranger = await mk("stranger");
    team = (await q(`INSERT INTO groups (name) VALUES ('Wiki Test team') RETURNING id`)).rows[0].id as string;
    await q(`INSERT INTO group_memberships (group_id, user_id) VALUES ($1, $2)`, [team, reader]);

    const settings = { get: async (k: string) => values[k] };
    const notifications = {
      createMany: async (inputs: Array<{ recipientUserId: string; kind: string; title: string; body?: string; link?: string }>) => {
        for (const i of inputs) sent.push({ recipients: [i.recipientUserId], kind: i.kind, title: i.title, body: i.body ?? "", link: i.link ?? "" });
      },
    };
    const none = { changed: () => undefined, record: async () => undefined, notify: async () => undefined, assertExists: async () => undefined };
    wiki = new WikiService(db as never, none as never, none as never, none as never, none as never, none as never, settings as never);
    review = new WikiReview(db as never, { register: () => undefined } as never, settings as never, notifications as never);
    templates = new WikiTemplatesService(db as never);
  });
  afterAll(async () => {
    await q(`DELETE FROM wiki_templates`);
    await q(`DELETE FROM wiki_pages`);
    await q(`DELETE FROM group_memberships WHERE group_id IN (SELECT id FROM groups WHERE name LIKE 'Wiki Test%')`);
    await q(`DELETE FROM groups WHERE name LIKE 'Wiki Test%'`);
    await q(`DELETE FROM users WHERE email LIKE 'wk-%@test.local'`);
    await pool?.end();
  });
  beforeEach(async () => {
    await q(`DELETE FROM wiki_templates`);
    await q(`DELETE FROM wiki_pages`);
    values = {};
    sent = [];
  });

  describe("backlinks", () => {
    it("lists the readable pages that really link here, with the sentence, and never the page itself", async () => {
      const target = await addPage({ title: "Core switch" });
      const a = await addPage({ title: "Network overview", body: `Cabling is covered in [the core switch](/wiki/${target}) page.` });
      await addPage({ title: "Pasted address", body: `See https://dash.example.org/wiki/${target.toUpperCase()}#ports now` });
      await addPage({ title: "Only in code", body: "Use `/wiki/" + target + "` in the path.\n```\n/wiki/" + target + "\n```" });
      await addPage({ title: "Edit link", body: `[change it](/wiki/${target}/edit)` });
      await addPage({ title: "Unrelated", body: "nothing here" });
      await q(`UPDATE wiki_pages SET body = body || $2 WHERE id = $1`, [target, `\nSelf: /wiki/${target}`]);

      const out = await wiki.backlinks(person(reader, base), target);
      expect(out.map((p) => p.title)).toEqual(["Network overview", "Pasted address"]);
      expect(out.find((p) => p.id === a)?.context).toBe("Cabling is covered in the core switch page.");
    });

    it("never names a restricted page to someone who cannot read it, and shows it to those who can", async () => {
      const target = await addPage({ title: "Target" });
      const secret = await addPage({ title: "Secret plans", visibility: "group", body: `Mentions [target](/wiki/${target})` });
      await addPage({ title: "Open page", body: `[target](/wiki/${target})` });
      await q(`INSERT INTO wiki_page_acl (page_id, group_id, can_edit) VALUES ($1, $2, false)`, [secret, team]);

      expect((await wiki.backlinks(person(stranger, base), target)).map((p) => p.title)).toEqual(["Open page"]);
      expect((await wiki.backlinks(person(reader, base), target)).map((p) => p.title)).toEqual(["Open page", "Secret plans"]);
      expect((await wiki.backlinks(person(stranger, ["wiki:read:any", ...base]), target)).map((p) => p.title)).toEqual(["Open page", "Secret plans"]);
    });

    it("answers 404 for a page the caller cannot read, so its existence is not given away", async () => {
      const secret = await addPage({ title: "Hidden", visibility: "group" });
      await expect(wiki.backlinks(person(stranger, base), secret)).rejects.toThrow(/not found/i);
    });
  });

  describe("review state", () => {
    it("uses the site setting, the page's own interval and the later of edit and review", async () => {
      values[WIKI_REVIEW_DAYS_KEY] = 100;
      const stale = await addPage({ title: "Old" , daysSinceEdit: 150 });
      const fresh = await addPage({ title: "Fresh", daysSinceEdit: 10 });
      const reviewed = await addPage({ title: "Reviewed", daysSinceEdit: 400, reviewedDaysAgo: 20 });
      const never = await addPage({ title: "Evergreen", daysSinceEdit: 900, interval: 0 });
      const own = await addPage({ title: "Short fuse", daysSinceEdit: 40, interval: 30 });

      const out = await wiki.reviewList(person(reader, base), { scope: "all", limit: 100 });
      expect(out.total).toBe(2);
      expect(out.items.map((p) => p.title)).toEqual(["Old", "Short fuse"]);
      expect(out.items[0]).toMatchObject({ id: stale, intervalDays: 100, daysOverdue: 50 });
      expect(out.items.map((p) => p.id)).not.toContain(fresh);
      expect(out.items.map((p) => p.id)).not.toContain(reviewed);
      expect(out.items.map((p) => p.id)).not.toContain(never);
      expect(out.items[1]!.id).toBe(own);

      const one = await wiki.getWithAcl(person(reader, base), stale);
      expect(one.review).toMatchObject({ needsReview: true, usingDefault: true, intervalDays: 100, lastReviewedAt: null });
      const two = await wiki.getWithAcl(person(reader, base), reviewed);
      expect(two.review).toMatchObject({ needsReview: false });
      expect(two.review.lastReviewedAt).toBeTruthy();
    });

    it("flags nothing when the site check is off, except pages with their own interval", async () => {
      values[WIKI_REVIEW_DAYS_KEY] = 0;
      await addPage({ title: "Old", daysSinceEdit: 900 });
      await addPage({ title: "Own", daysSinceEdit: 90, interval: 30 });
      const out = await wiki.reviewList(person(reader, base), { scope: "all", limit: 100 });
      expect(out.items.map((p) => p.title)).toEqual(["Own"]);
    });

    it("lists only pages the caller can read, and 'mine' only their own", async () => {
      values[WIKI_REVIEW_DAYS_KEY] = 30;
      await addPage({ title: "Public old", daysSinceEdit: 60 });
      const secret = await addPage({ title: "Secret old", daysSinceEdit: 60, visibility: "group", owner });
      await q(`INSERT INTO wiki_page_acl (page_id, group_id, can_edit) VALUES ($1, $2, false)`, [secret, team]);
      await addPage({ title: "Editor's old", daysSinceEdit: 60, owner: editor });

      expect((await wiki.reviewList(person(stranger, base), { scope: "all", limit: 100 })).items.map((p) => p.title).sort()).toEqual(["Editor's old", "Public old"]);
      expect((await wiki.reviewList(person(reader, base), { scope: "all", limit: 100 })).total).toBe(3);
      expect((await wiki.reviewList(person(editor, base), { scope: "mine", limit: 100 })).items.map((p) => p.title)).toEqual(["Editor's old"]);
      expect((await wiki.reviewList(person(stranger, base), { scope: "all", limit: 1 })).items).toHaveLength(1);
    });
  });

  describe("confirming a page", () => {
    it("records who and when without making an edit or a revision", async () => {
      values[WIKI_REVIEW_DAYS_KEY] = 30;
      const id = await addPage({ title: "Doc", daysSinceEdit: 90 });
      const before = await state(id);

      const out = await wiki.markReviewed(person(owner, base), id);
      expect(out.needsReview).toBe(false);
      const after = await state(id);
      expect(after.rb).toBe(owner);
      expect(after.r).toBeGreaterThan(Date.now() - 60_000);
      expect(after.u).toBe(before.u);
      expect(await revisionCount(id)).toBe(0);
      expect((await wiki.reviewList(person(owner, base), { scope: "all", limit: 10 })).total).toBe(0);
    });

    it("needs the right to edit the page, and says 404 when the page cannot be read", async () => {
      const id = await addPage({ title: "Doc", owner });
      await expect(wiki.markReviewed(person(reader, base), id)).rejects.toThrow(/cannot edit/i);
      const hidden = await addPage({ title: "Hidden", visibility: "group" });
      await expect(wiki.markReviewed(person(stranger, base), hidden)).rejects.toThrow(/not found/i);
      await q(`INSERT INTO wiki_page_acl (page_id, group_id, can_edit) VALUES ($1, $2, true)`, [id, team]);
      await expect(wiki.markReviewed(person(reader, base), id)).resolves.toMatchObject({ lastReviewedBy: reader });
    });

    it("restarts the clock after an edit too: an edited page is no longer due", async () => {
      values[WIKI_REVIEW_DAYS_KEY] = 30;
      const id = await addPage({ title: "Doc", daysSinceEdit: 90 });
      expect((await wiki.reviewList(person(owner, base), { scope: "all", limit: 10 })).total).toBe(1);
      await wiki.update(person(owner, base), id, { body: "new text" });
      expect((await wiki.reviewList(person(owner, base), { scope: "all", limit: 10 })).total).toBe(0);
    });
  });

  describe("choosing how often a page is checked", () => {
    it("is not an edit: no revision and updated_at stays", async () => {
      const id = await addPage({ title: "Doc", daysSinceEdit: 5 });
      const before = await state(id);
      await wiki.update(person(owner, base), id, { reviewIntervalDays: 365 });
      const after = await state(id);
      expect(after.i).toBe(365);
      expect(after.u).toBe(before.u);
      expect(await revisionCount(id)).toBe(0);
      await wiki.update(person(owner, base), id, { reviewIntervalDays: null });
      expect((await state(id)).i).toBeNull();
    });

    it("is for the owner or a wiki admin, not for an editor with access", async () => {
      const id = await addPage({ title: "Doc", owner });
      await q(`INSERT INTO wiki_page_acl (page_id, group_id, can_edit) VALUES ($1, $2, true)`, [id, team]);
      await expect(wiki.update(person(reader, base), id, { reviewIntervalDays: 0 })).rejects.toThrow(/owner/i);
      await wiki.update(person(reader, base), id, { body: "an editor may still change the text" });
      await expect(wiki.update(person(stranger, ["wiki:admin", ...base]), id, { reviewIntervalDays: 90 })).resolves.toBeTruthy();
      expect((await state(id)).i).toBe(90);
    });

    it("still bumps updated_at for an ordinary edit and for an empty update", async () => {
      const id = await addPage({ title: "Doc", daysSinceEdit: 5 });
      const before = await state(id);
      await wiki.update(person(owner, base), id, { title: "Doc 2" });
      expect((await state(id)).u).toBeGreaterThan(before.u);
      await expect(wiki.update(person(owner, base), id, {})).resolves.toBeTruthy();
    });
  });

  describe("the review reminder job", () => {
    it("tells an owner once, in one message for all their pages, and not again", async () => {
      values[WIKI_REVIEW_DAYS_KEY] = 100;
      const a = await addPage({ title: "Alpha", daysSinceEdit: 101 });
      const b = await addPage({ title: "Beta", daysSinceEdit: 100.5 });
      await addPage({ title: "Current", daysSinceEdit: 5 });
      const mine = await addPage({ title: "Gamma", daysSinceEdit: 101, owner: editor });

      const first = await review.run();
      expect(first).toMatchObject({ notified: 2, pages: 3, silent: 0 });
      const forOwner = sent.find((s) => s.recipients[0] === owner)!;
      expect(forOwner.kind).toBe("wiki.review_due");
      expect(forOwner.title).toMatch(/^2 of your wiki pages/);
      expect(forOwner.body).toMatch(/Alpha/);
      expect(forOwner.link).toBe("/wiki/review?scope=mine");
      const forEditor = sent.find((s) => s.recipients[0] === editor)!;
      expect(forEditor.title).toMatch(/Gamma/);
      expect(forEditor.link).toBe(`/wiki/${mine}`);
      for (const id of [a, b, mine]) expect((await state(id)).n).not.toBeNull();

      sent = [];
      expect(await review.run()).toMatchObject({ notified: 0, pages: 0, silent: 0 });
      expect(sent).toEqual([]);
    });

    it("flags a page that has been due for a long time without a message", async () => {
      values[WIKI_REVIEW_DAYS_KEY] = 100;
      const id = await addPage({ title: "Ancient", daysSinceEdit: 500 });
      expect(await review.run()).toMatchObject({ notified: 0, pages: 0, silent: 1 });
      expect(sent).toEqual([]);
      expect((await state(id)).n).not.toBeNull();
      expect(await review.run()).toMatchObject({ silent: 0 });
    });

    it("announces the page again after it was confirmed and has come due once more", async () => {
      values[WIKI_REVIEW_DAYS_KEY] = 100;
      const id = await addPage({ title: "Doc", daysSinceEdit: 101 });
      await review.run();
      sent = [];
      await wiki.markReviewed(person(owner, base), id);
      expect(await review.run()).toMatchObject({ pages: 0 });
      // Move the whole history back in time: edited long ago, notified, confirmed after that, and now due again.
      await q(
        `UPDATE wiki_pages SET updated_at = now() - interval '400 days', review_notified_at = now() - interval '250 days',
                last_reviewed_at = now() - interval '101 days' WHERE id = $1`,
        [id],
      );
      expect(await review.run()).toMatchObject({ notified: 1, pages: 1 });
    });

    it("does nothing while the site check is off and respects a page's own interval", async () => {
      values[WIKI_REVIEW_DAYS_KEY] = 0;
      await addPage({ title: "Old", daysSinceEdit: 400 });
      await addPage({ title: "Never", daysSinceEdit: 400, interval: 0 });
      expect(await review.run()).toMatchObject({ notified: 0, pages: 0, silent: 0 });
      await addPage({ title: "Own", daysSinceEdit: 31, interval: 30 });
      expect(await review.run()).toMatchObject({ notified: 1, pages: 1 });
    });

    it("lets only one of two simultaneous runs announce a page", async () => {
      values[WIKI_REVIEW_DAYS_KEY] = 100;
      await addPage({ title: "Doc", daysSinceEdit: 101 });
      const [x, y] = await Promise.all([review.run(), review.run()]);
      expect(x.pages + y.pages).toBe(1);
      expect(sent).toHaveLength(1);
    });
  });

  describe("templates", () => {
    it("creates, lists in name order, updates and deletes", async () => {
      const b = await templates.create(owner, { name: "Beta", description: "", body: "b" });
      await templates.create(owner, { name: "Alpha", description: "first", body: "a" });
      expect((await templates.list()).map((t) => t.name)).toEqual(["Alpha", "Beta"]);
      const changed = await templates.update(b.id, { description: "second" });
      expect(changed).toMatchObject({ name: "Beta", description: "second", body: "b" });
      expect(changed.updatedAt.getTime()).toBeGreaterThanOrEqual(b.updatedAt.getTime());
      await templates.remove(b.id);
      expect((await templates.list()).map((t) => t.name)).toEqual(["Alpha"]);
      await expect(templates.remove(b.id)).rejects.toThrow(/not found/i);
      await expect(templates.update(b.id, { name: "x" })).rejects.toThrow(/not found/i);
    });
  });
});
