/**
 * Helpdesk smoke tests, run from run.mjs: waiting on the requester, saved replies, the SLA and mailbox settings, and the
 * mailbox's status routes (the mailbox itself is never switched on here: it would read a real server). Everything made here
 * is deleted before the block ends.
 */
export async function helpdeskTests({ test, assert, fetchWithCookies, jar }) {
  const json = (body) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const session = (path, init = {}) => fetchWithCookies(path, init, jar);
  const bearer = (token, path, init = {}) =>
    fetchWithCookies(path, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` } }, new Map());
  const ticketsMade = [];
  const repliesMade = [];
  let token = null;

  const makeTicket = async (title) => {
    const { res } = await session("/api/v1/tickets", { method: "POST", ...json({ title, description: "from smoke", priority: "normal" }) });
    assert(res.status === 200 || res.status === 201, `create status ${res.status}`);
    const t = await res.json();
    ticketsMade.push(t.id);
    return t;
  };
  const getTicket = async (id) => (await (await session(`/api/v1/tickets/${id}`)).res.json());

  try {
    // ---- waiting on the requester ----
    let t;
    await test("waiting: staff can park a ticket, which starts the pause", async () => {
      t = await makeTicket("[smoke] waiting ticket");
      const { res } = await session(`/api/v1/tickets/${t.id}`, { method: "PATCH", ...json({ status: "waiting" }) });
      assert(res.status === 200, `status ${res.status}`);
      const body = await res.json();
      assert(body.status === "waiting", `status ${body.status}`);
      assert(typeof body.waitingSince === "string", `waitingSince ${body.waitingSince}`);
      assert(body.waitedMs === 0, `waitedMs ${body.waitedMs}`);
    });

    await test("waiting: the requester's reply puts the ticket back to work and adds the wait to the total", async () => {
      await new Promise((r) => setTimeout(r, 1200));
      const { res } = await session(`/api/v1/tickets/${t.id}/comments`, { method: "POST", ...json({ body: "Here is the answer" }) });
      assert(res.status === 200 || res.status === 201, `comment status ${res.status}`);
      const after = await getTicket(t.id);
      assert(after.status === "open", `status ${after.status}`);
      assert(after.waitingSince === null, `waitingSince ${after.waitingSince}`);
      assert(after.waitedMs >= 1000, `waitedMs ${after.waitedMs}`);
      const comments = await (await session(`/api/v1/tickets/${t.id}/comments`)).res.json();
      assert(comments.some((c) => c.kind === "event" && /replied: status changed from waiting to open/.test(c.body)), "no event");
    });

    await test("waiting: bulk actions can set it, and an unknown status is refused", async () => {
      const { res } = await session("/api/v1/tickets/bulk", { method: "POST", ...json({ ids: [t.id], action: { kind: "set_status", status: "waiting" } }) });
      assert(res.status === 200 || res.status === 201, `bulk status ${res.status}`);
      const out = await res.json();
      assert(out.applied === 1, `bulk: ${JSON.stringify(out)}`);
      assert((await getTicket(t.id)).status === "waiting", "not waiting");
      const bad = await session(`/api/v1/tickets/${t.id}`, { method: "PATCH", ...json({ status: "paused" }) });
      assert(bad.res.status === 400, `unknown status ${bad.res.status}`);
    });

    await test("waiting: a staff comment does not move a waiting ticket", async () => {
      const mine = await getTicket(t.id);
      assert(mine.status === "waiting", "precondition");
      const { res } = await session(`/api/v1/tickets/${t.id}/comments`, { method: "POST", ...json({ body: "internal note", isInternal: true }) });
      assert(res.status === 200 || res.status === 201, `comment status ${res.status}`);
      assert((await getTicket(t.id)).status === "waiting", "an internal note must not wake the ticket");
    });

    // ---- saved replies ----
    await test("saved replies: need a session", async () => {
      const { res } = await fetchWithCookies("/api/v1/tickets/canned-replies");
      assert(res.status === 401, `status ${res.status}`);
    });

    let reply;
    await test("saved replies: create, list in title order, edit", async () => {
      const mk = async (title, body) => {
        const { res } = await session("/api/v1/tickets/canned-replies", { method: "POST", ...json({ title, body }) });
        assert(res.status === 200 || res.status === 201, `create status ${res.status}`);
        const r = await res.json();
        repliesMade.push(r.id);
        return r;
      };
      reply = await mk("[smoke] Zebra reply", "Hi {{requester}}, please restart it.");
      await mk("[smoke] Alpha reply", "Which room?");
      const { res } = await session("/api/v1/tickets/canned-replies");
      assert(res.status === 200, `list status ${res.status}`);
      const titles = (await res.json()).map((r) => r.title).filter((x) => x.startsWith("[smoke]"));
      assert(titles.join("|") === "[smoke] Alpha reply|[smoke] Zebra reply", `order: ${titles.join("|")}`);
      const edited = await session(`/api/v1/tickets/canned-replies/${reply.id}`, { method: "PATCH", ...json({ body: "Hi {{requester}}, try again." }) });
      assert(edited.res.status === 200, `edit status ${edited.res.status}`);
      const after = await edited.res.json();
      assert(after.body === "Hi {{requester}}, try again." && after.title === "[smoke] Zebra reply", `edited: ${JSON.stringify(after)}`);
    });

    await test("saved replies: empty title, oversized body and malformed ids are refused", async () => {
      const empty = await session("/api/v1/tickets/canned-replies", { method: "POST", ...json({ title: "  ", body: "x" }) });
      assert(empty.res.status === 400, `empty title ${empty.res.status}`);
      const big = await session("/api/v1/tickets/canned-replies", { method: "POST", ...json({ title: "big", body: "x".repeat(5001) }) });
      assert(big.res.status === 400, `big body ${big.res.status}`);
      const bad = await session("/api/v1/tickets/canned-replies/not-a-uuid", { method: "PATCH", ...json({ title: "x" }) });
      assert(bad.res.status === 400, `bad id ${bad.res.status}`);
      const missing = await session("/api/v1/tickets/canned-replies/00000000-0000-4000-8000-000000000000", { method: "DELETE" });
      assert(missing.res.status === 404, `missing ${missing.res.status}`);
    });

    await test("saved replies: a token limited to notes cannot reach them", async () => {
      const { res } = await session("/api/v1/me/api-tokens", { method: "POST", ...json({ name: "smoke helpdesk", modules: ["notes"], expiresInDays: 1 }) });
      assert(res.status === 201 || res.status === 200, `token status ${res.status}`);
      token = await res.json();
      const list = await bearer(token.token, "/api/v1/tickets/canned-replies");
      assert(list.res.status === 403, `list with token ${list.res.status}`);
    });

    await test("saved replies: delete removes it", async () => {
      const id = repliesMade.shift();
      const del = await session(`/api/v1/tickets/canned-replies/${id}`, { method: "DELETE" });
      assert(del.res.status === 200, `delete status ${del.res.status}`);
      const again = await session(`/api/v1/tickets/canned-replies/${id}`, { method: "DELETE" });
      assert(again.res.status === 404, `second delete ${again.res.status}`);
    });

    // ---- settings ----
    const put = (key, value) => session(`/api/v1/settings/${key}`, { method: "PUT", ...json({ value }) });
    await test("settings: the SLA warning percentage is range checked", async () => {
      assert((await put("tickets.sla.warn_percent", 96)).res.status === 400, "96");
      assert((await put("tickets.sla.warn_percent", -1)).res.status === 400, "-1");
      assert((await put("tickets.sla.warn_percent", 80)).res.status === 200, "80");
    });

    await test("settings: the mailbox settings are checked, and it cannot be switched on half set up", async () => {
      assert((await put("tickets.inbound.host", "imap://mail.example.org")).res.status === 400, "host with a scheme");
      assert((await put("tickets.inbound.port", 70000)).res.status === 400, "port");
      assert((await put("tickets.inbound.auth", "lax")).res.status === 400, "auth mode");
      assert((await put("tickets.inbound.address", "not an address")).res.status === 400, "address");
      assert((await put("tickets.inbound.mailbox", "")).res.status === 400, "folder");
      const on = await put("tickets.inbound.enabled", true);
      assert(on.res.status === 400, `switching on without a server, login and address: ${on.res.status}`);
    });

    // ---- the mailbox's own routes ----
    await test("mailbox: status reads for a site admin, and says it is not set up", async () => {
      const { res } = await session("/api/v1/tickets/inbound/status");
      assert(res.status === 200, `status ${res.status}`);
      const s = await res.json();
      assert(s.enabled === false && s.configured === false, `shape: ${JSON.stringify(s)}`);
      assert(s.week && typeof s.week.ticket === "number" && Array.isArray(s.recent), "week / recent");
      assert(!JSON.stringify(s).includes("password"), "a password field leaked");
    });

    await test("mailbox: test and check answer plainly when nothing is set up", async () => {
      const test1 = await session("/api/v1/tickets/inbound/test", { method: "POST" });
      assert(test1.res.status === 200 || test1.res.status === 201, `test status ${test1.res.status}`);
      const r = await test1.res.json();
      assert(r.ok === false && /server|login|password/i.test(r.message), `test: ${JSON.stringify(r)}`);
      const check = await session("/api/v1/tickets/inbound/check", { method: "POST" });
      assert(check.res.status === 200 || check.res.status === 201, `check status ${check.res.status}`);
      assert((await check.res.json()).state === "off", "check should be off");
    });

    await test("mailbox: its routes are closed to tokens", async () => {
      const s = await bearer(token.token, "/api/v1/tickets/inbound/status");
      assert(s.res.status === 403 || s.res.status === 401, `status via token ${s.res.status}`);
      const c = await bearer(token.token, "/api/v1/tickets/inbound/check", { method: "POST" });
      assert(c.res.status === 403 || c.res.status === 401, `check via token ${c.res.status}`);
    });
  } finally {
    for (const id of ticketsMade) await session(`/api/v1/tickets/${id}`, { method: "DELETE" }).catch(() => undefined);
    for (const id of repliesMade) await session(`/api/v1/tickets/canned-replies/${id}`, { method: "DELETE" }).catch(() => undefined);
    if (token) await session(`/api/v1/me/api-tokens/${token.id}`, { method: "DELETE" }).catch(() => undefined);
    await session("/api/v1/settings/tickets.sla.warn_percent", { method: "PUT", ...json({ value: 80 }) }).catch(() => undefined);
  }
}
