/**
 * Wiki upkeep smoke tests, run from run.mjs: page templates, "linked from", confirming a page and how often it is checked.
 * A page can only be made stale by time, so what makes a page due is covered by apps/api/test/wiki-upkeep.integration.test.ts.
 * Everything made here is deleted before the block ends.
 */
export async function wikiUpkeepTests({ test, assert, fetchWithCookies, jar }) {
  const json = (body) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const session = (path, init = {}) => fetchWithCookies(path, init, jar);
  const pagesMade = [];
  const templatesMade = [];

  const makePage = async (title, body = "") => {
    const { res } = await session("/api/v1/wiki", { method: "POST", ...json({ title, body, visibility: "public" }) });
    assert(res.status === 200 || res.status === 201, `create page status ${res.status}`);
    const p = await res.json();
    pagesMade.push(p.id);
    return p;
  };
  const getPage = async (id) => (await session(`/api/v1/wiki/${id}`)).res.json();
  const revisionCount = async (id) => (await (await session(`/api/v1/wiki/${id}/revisions`)).res.json()).length;

  try {
    // ---- templates ----
    await test("templates: need a session", async () => {
      const { res } = await fetchWithCookies("/api/v1/wiki/templates");
      assert(res.status === 401, `status ${res.status}`);
    });

    let tpl;
    await test("templates: create, list in name order, edit", async () => {
      const mk = async (name, body) => {
        const { res } = await session("/api/v1/wiki/templates", { method: "POST", ...json({ name, description: `about ${name}`, body }) });
        assert(res.status === 200 || res.status === 201, `create status ${res.status}`);
        const t = await res.json();
        templatesMade.push(t.id);
        return t;
      };
      await mk("[smoke] Zulu", "z");
      tpl = await mk("[smoke] Alpha", "## Steps\n\n1. one\n\nOn {{date}} by {{author}}");
      const list = await (await session("/api/v1/wiki/templates")).res.json();
      const mine = list.filter((t) => t.name.startsWith("[smoke]")).map((t) => t.name);
      assert(JSON.stringify(mine) === JSON.stringify(["[smoke] Alpha", "[smoke] Zulu"]), `order ${JSON.stringify(mine)}`);
      const { res } = await session(`/api/v1/wiki/templates/${tpl.id}`, { method: "PATCH", ...json({ description: "changed" }) });
      assert(res.status === 200, `patch status ${res.status}`);
      const out = await res.json();
      assert(out.description === "changed" && out.name === "[smoke] Alpha", `after patch ${JSON.stringify(out)}`);
    });

    await test("templates: a blank name, a missing body and an unknown id are refused", async () => {
      assert((await session("/api/v1/wiki/templates", { method: "POST", ...json({ name: "  ", body: "x" }) })).res.status === 400, "blank name");
      assert((await session("/api/v1/wiki/templates", { method: "POST", ...json({ name: "x" }) })).res.status === 400, "no body");
      const missing = "00000000-0000-4000-8000-000000000000";
      assert((await session(`/api/v1/wiki/templates/${missing}`, { method: "PATCH", ...json({ name: "y" }) })).res.status === 404, "unknown id");
      assert((await session(`/api/v1/wiki/templates/not-a-uuid`, { method: "DELETE" })).res.status === 400, "bad id");
    });

    await test("templates: creating and deleting are audited", async () => {
      const gone = templatesMade.pop();
      const del = await session(`/api/v1/wiki/templates/${gone}`, { method: "DELETE" });
      assert(del.res.status === 200, `delete status ${del.res.status}`);
      await new Promise((r) => setTimeout(r, 300));
      const { res } = await session("/api/v1/audit?resourceType=wiki_template&limit=20");
      assert(res.status === 200, `audit status ${res.status}`);
      const actions = new Set(((await res.json()).items ?? []).map((r) => r.action));
      assert(actions.has("wiki.template.create") && actions.has("wiki.template.delete"), `actions ${[...actions].join(",")}`);
    });

    // ---- linked from ----
    let target;
    let linker;
    await test("linked from: needs a session, and a page that nobody links to has none", async () => {
      target = await makePage("[smoke] link target", "the target");
      const anon = await fetchWithCookies(`/api/v1/wiki/${target.id}/backlinks`);
      assert(anon.res.status === 401, `anon status ${anon.res.status}`);
      const { res } = await session(`/api/v1/wiki/${target.id}/backlinks`);
      assert(res.status === 200, `status ${res.status}`);
      assert((await res.json()).length === 0, "expected no backlinks");
    });

    await test("linked from: lists a page that links here, with the sentence, and not one that only mentions the address in code", async () => {
      linker = await makePage("[smoke] linker", `Setup is described in [the target page](/wiki/${target.id}) in full.`);
      await makePage("[smoke] code only", "Example: `/wiki/" + target.id + "`");
      const out = await (await session(`/api/v1/wiki/${target.id}/backlinks`)).res.json();
      assert(out.length === 1, `expected 1, got ${out.length}`);
      assert(out[0].id === linker.id && out[0].title === "[smoke] linker", `row ${JSON.stringify(out[0])}`);
      assert(out[0].context === "Setup is described in the target page in full.", `context ${out[0].context}`);
    });

    await test("linked from: follows an edit at once, and an unknown page is a 404", async () => {
      const { res } = await session(`/api/v1/wiki/${linker.id}`, { method: "PATCH", ...json({ body: "No link any more." }) });
      assert(res.status === 200, `patch status ${res.status}`);
      assert((await (await session(`/api/v1/wiki/${target.id}/backlinks`)).res.json()).length === 0, "link should be gone");
      const missing = await session("/api/v1/wiki/00000000-0000-4000-8000-000000000000/backlinks");
      assert(missing.res.status === 404, `unknown page ${missing.res.status}`);
    });

    // ---- confirming a page and how often it is checked ----
    await test("review: a new page is not due, shows no confirmation, and the list is well formed", async () => {
      const page = await getPage(target.id);
      assert(page.review && page.review.needsReview === false, `review ${JSON.stringify(page.review)}`);
      assert(page.review.lastReviewedAt === null && page.review.usingDefault === true, "fresh page");
      assert(page.canManage === true && page.isAdmin === true, `flags ${page.canManage} ${page.isAdmin}`);
      const list = await (await session("/api/v1/wiki/review?scope=mine&limit=5")).res.json();
      assert(typeof list.total === "number" && Array.isArray(list.items), `list ${JSON.stringify(list)}`);
      assert((await session("/api/v1/wiki/review?scope=everyone")).res.status === 400, "bad scope");
    });

    await test("review: confirming records who and when, and is not an edit", async () => {
      const before = await getPage(target.id);
      const revisions = await revisionCount(target.id);
      const { res } = await session(`/api/v1/wiki/${target.id}/review`, { method: "POST" });
      assert(res.status === 200 || res.status === 201, `status ${res.status}`);
      const out = await res.json();
      assert(out.needsReview === false && typeof out.lastReviewedAt === "string", `out ${JSON.stringify(out)}`);
      const after = await getPage(target.id);
      assert(after.review.lastReviewedAt === out.lastReviewedAt && after.review.reviewedBy, `after ${JSON.stringify(after.review)}`);
      assert(after.page.updatedAt === before.page.updatedAt, "confirming must not change updatedAt");
      assert((await revisionCount(target.id)) === revisions, "confirming must not add a revision");
      const anon = await fetchWithCookies(`/api/v1/wiki/${target.id}/review`, { method: "POST" });
      assert(anon.res.status === 401, `anon status ${anon.res.status}`);
    });

    await test("review: the page's own interval can be set and cleared without an edit", async () => {
      const before = await getPage(target.id);
      const revisions = await revisionCount(target.id);
      let r = await session(`/api/v1/wiki/${target.id}`, { method: "PATCH", ...json({ reviewIntervalDays: 0 }) });
      assert(r.res.status === 200, `status ${r.res.status}`);
      let page = await getPage(target.id);
      assert(page.review.intervalDays === 0 && page.review.usingDefault === false && page.review.dueAt === null, `never: ${JSON.stringify(page.review)}`);
      r = await session(`/api/v1/wiki/${target.id}`, { method: "PATCH", ...json({ reviewIntervalDays: 90 }) });
      page = await getPage(target.id);
      assert(page.review.intervalDays === 90 && typeof page.review.dueAt === "string", `90: ${JSON.stringify(page.review)}`);
      assert(page.page.updatedAt === before.page.updatedAt && (await revisionCount(target.id)) === revisions, "not an edit");
      assert((await session(`/api/v1/wiki/${target.id}`, { method: "PATCH", ...json({ reviewIntervalDays: -1 }) })).res.status === 400, "-1");
      assert((await session(`/api/v1/wiki/${target.id}`, { method: "PATCH", ...json({ reviewIntervalDays: 99999 }) })).res.status === 400, "99999");
      await session(`/api/v1/wiki/${target.id}`, { method: "PATCH", ...json({ reviewIntervalDays: null }) });
      assert((await getPage(target.id)).review.usingDefault === true, "back to the site setting");
    });

    await test("review: the site setting is range checked", async () => {
      const put = (v) => session("/api/v1/settings/wiki.review.default_days", { method: "PUT", ...json({ value: v }) });
      assert((await put(-1)).res.status === 400, "-1");
      assert((await put(3651)).res.status === 400, "3651");
      assert((await put(1.5)).res.status === 400, "1.5");
      assert((await put(180)).res.status === 200, "180");
    });

    // ---- archiving ----
    await test("archive: needs a session", async () => {
      const anon = await fetchWithCookies(`/api/v1/wiki/${target.id}/archive`, { method: "POST" });
      assert(anon.res.status === 401, `anon status ${anon.res.status}`);
    });

    await test("archive: out of the menu and the list, last in searches, readable by address, and back again", async () => {
      const word = `zqarch${Date.now().toString(36)}`;
      const live1 = await makePage(`[smoke] ${word} live one`, word);
      const live2 = await makePage(`[smoke] ${word} live two`, word);
      const put = await makePage(`[smoke] ${word} put away`, word); // the newest, so it would be first if archiving changed nothing
      const before = await getPage(put.id);
      const revisions = await revisionCount(put.id);

      const bad = await session(`/api/v1/wiki/not-a-uuid/archive`, { method: "POST" });
      assert(bad.res.status === 400 || bad.res.status === 404, `bad id status ${bad.res.status}`);

      const r = await session(`/api/v1/wiki/${put.id}/archive`, { method: "POST" });
      assert(r.res.status === 200 || r.res.status === 201, `archive status ${r.res.status}`);
      const archivedAt = (await r.res.json()).archivedAt;
      assert(typeof archivedAt === "string", "archivedAt in the answer");
      const twice = await (await session(`/api/v1/wiki/${put.id}/archive`, { method: "POST" })).res.json();
      assert(twice.archivedAt === archivedAt, "a second archive keeps the first date");

      const page = await getPage(put.id);
      assert(page.page.archivedAt === archivedAt && page.archivedBy?.email, `page: ${JSON.stringify(page.archivedBy)}`);
      assert(page.page.updatedAt === before.page.updatedAt && (await revisionCount(put.id)) === revisions, "not an edit");

      const menu = await (await session("/api/v1/wiki/tree")).res.json();
      assert(!menu.some((n) => n.id === put.id), "archived page is not in the menu");
      assert(menu.some((n) => n.id === live1.id), "live page is in the menu");
      const withArchived = await (await session("/api/v1/wiki/tree?archived=1")).res.json();
      assert(withArchived.find((n) => n.id === put.id)?.archived === true, "flagged when asked for");

      const browse = await (await session("/api/v1/wiki?limit=200")).res.json();
      assert(!browse.some((p) => p.id === put.id), "not in the browse list");
      const found = await (await session(`/api/v1/wiki?q=${word}`)).res.json();
      assert(found.map((p) => p.id).at(-1) === put.id && found.length === 3, `list order: ${found.map((p) => p.title)}`);

      // The search index follows the database within a moment.
      const hits = async () => (await (await session(`/api/v1/search?q=${word}&kind=wiki`)).res.json()).hits;
      let h = [];
      for (let i = 0; i < 40; i++) {
        h = await hits();
        if (h.find((x) => x.resourceId === put.id)?.archived === true) break;
        await new Promise((res) => setTimeout(res, 500));
      }
      assert(h.length === 3 && h.at(-1).resourceId === put.id && h.at(-1).archived === true, `search order: ${JSON.stringify(h.map((x) => [x.title, x.archived]))}`);
      assert(h.slice(0, 2).every((x) => x.archived !== true && [live1.id, live2.id].includes(x.resourceId)), "live pages first");

      const u = await session(`/api/v1/wiki/${put.id}/unarchive`, { method: "POST" });
      assert(u.res.status === 200 || u.res.status === 201, `unarchive status ${u.res.status}`);
      assert((await getPage(put.id)).page.archivedAt === null, "archivedAt cleared");
      assert((await (await session("/api/v1/wiki/tree")).res.json()).some((n) => n.id === put.id), "back in the menu");
      for (let i = 0; i < 40; i++) {
        h = await hits();
        if (h.find((x) => x.resourceId === put.id)?.archived !== true) break;
        await new Promise((res) => setTimeout(res, 500));
      }
      assert(h.find((x) => x.resourceId === put.id)?.archived !== true, "no longer flagged in search");
    });
  } finally {
    for (const id of pagesMade) await session(`/api/v1/wiki/${id}`, { method: "DELETE" }).catch(() => undefined);
    for (const id of templatesMade) await session(`/api/v1/wiki/templates/${id}`, { method: "DELETE" }).catch(() => undefined);
    await session("/api/v1/settings/wiki.review.default_days", { method: "PUT", ...json({ value: 180 }) }).catch(() => undefined);
  }
}
