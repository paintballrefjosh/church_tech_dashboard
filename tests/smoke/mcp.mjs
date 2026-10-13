/**
 * MCP server smoke tests (POST /api/v1/mcp), run from run.mjs. Reads only: it creates short-lived API
 * tokens (revoked before the block ends) and speaks the Streamable HTTP protocol with plain fetch.
 */
export async function mcpTests({ test, assert, fetchWithCookies, jar }) {
  const session = (path, init = {}) => fetchWithCookies(path, init, jar);
  let nextId = 1;

  /** One JSON-RPC request to the MCP endpoint. */
  async function rpc(headers, method, params = {}) {
    const { res } = await fetchWithCookies(
      "/api/v1/mcp",
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
      },
      new Map(),
    );
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON: leave null */
    }
    return { status: res.status, body, text };
  }
  const call = (headers, name, args) => rpc(headers, "tools/call", { name, arguments: args });
  const toolText = (r) => r.body?.result?.content?.[0]?.text ?? "";

  async function mint(body) {
    const created = await session("/api/v1/me/api-tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expiresInDays: 1, ...body }),
    });
    assert(created.res.status === 201 || created.res.status === 200, `token status ${created.res.status}`);
    return created.res.json();
  }
  const revoke = (t) => session(`/api/v1/me/api-tokens/${t.id}`, { method: "DELETE" });
  const auth = (t) => ({ authorization: `Bearer ${t.token}` });

  await test("mcp: a browser session is refused, a bad token is a 401", async () => {
    const viaCookie = await fetchWithCookies(
      "/api/v1/mcp",
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      },
      jar,
    );
    assert(viaCookie.res.status === 401, `cookie status ${viaCookie.res.status}`);
    const bad = await rpc({ authorization: "Bearer cdt_not-a-real-token" }, "tools/list");
    assert(bad.status === 401, `bad token status ${bad.status}`);
  });

  await test("mcp: tools are listed per token (full, read-only, notes-only)", async () => {
    const full = await mint({ name: "smoke mcp full", readOnly: false });
    const ro = await mint({ name: "smoke mcp read-only" });
    const notes = await mint({ name: "smoke mcp notes", modules: ["notes"] });
    try {
      const names = async (t) => {
        const r = await rpc(auth(t), "tools/list");
        assert(r.status === 200, `tools/list status ${r.status}: ${r.text.slice(0, 200)}`);
        return r.body.result.tools.map((x) => x.name);
      };
      const fullNames = await names(full);
      assert(fullNames.includes("me_get_profile") && fullNames.includes("search_everything"), "general tools missing");
      assert(fullNames.includes("wiki_create_page"), "full token lacks wiki_create_page");

      const roNames = await names(ro);
      assert(roNames.includes("wiki_get_page"), "read-only token lacks a read tool");
      assert(!roNames.includes("wiki_create_page") && !roNames.includes("wiki_update_page"), "read-only token sees a write tool");

      const noteNames = await names(notes);
      assert(noteNames.includes("me_get_profile"), "notes token lacks me_get_profile");
      assert(!noteNames.some((n) => n.startsWith("wiki_")), `notes-only token sees wiki tools: ${noteNames.join(",")}`);
    } finally {
      await revoke(full);
      await revoke(ro);
      await revoke(notes);
    }
  });

  await test("mcp: a catalogue tool runs through the real route as the token's owner", async () => {
    const ro = await mint({ name: "smoke mcp profile" });
    try {
      const r = await call(auth(ro), "me_get_profile", {});
      assert(r.status === 200 && !r.body.result.isError, `profile: ${r.text.slice(0, 300)}`);
      const me = JSON.parse(toolText(r));
      assert(typeof me.email === "string" && Array.isArray(me.permissions), "profile shape");
      assert(me.apiToken?.readOnly === true, `profile does not show the token's limits: ${JSON.stringify(me.apiToken)}`);

      const s = await call(auth(ro), "search_everything", { q: "a", limit: 3 });
      assert(!s.body.result.isError, `search: ${toolText(s).slice(0, 300)}`);
      const found = JSON.parse(toolText(s));
      assert(Array.isArray(found.hits) && found.hits.length <= 3, "search hits shape");
    } finally {
      await revoke(ro);
    }
  });

  await test("mcp: bad arguments and unknown tools are tool errors, not crashes", async () => {
    const ro = await mint({ name: "smoke mcp errors" });
    try {
      const bad = await call(auth(ro), "search_everything", { q: "x", kind: ["nonsense"] });
      assert(bad.body.result?.isError === true, "bad kind was accepted");
      const none = await call(auth(ro), "no_such_tool", {});
      assert(none.body.result?.isError === true || none.body.error, "unknown tool was accepted");
    } finally {
      await revoke(ro);
    }
  });

  await test("mcp: a read-only token cannot call a write tool even by name", async () => {
    const ro = await mint({ name: "smoke mcp ro write" });
    try {
      const r = await call(auth(ro), "wiki_create_page", { title: "smoke should not exist" });
      assert(r.body.result?.isError === true, "write tool ran for a read-only token");
      assert(/read-only/.test(toolText(r)), `unexpected message: ${toolText(r)}`);
    } finally {
      await revoke(ro);
    }
  });

  // ---- Phase 1: work content, through the real routes ----

  /** Call a tool and return its parsed JSON, failing the test on a tool error. */
  async function run(headers, name, args) {
    const r = await call(headers, name, args);
    assert(r.status === 200, `${name}: HTTP ${r.status} ${r.text.slice(0, 200)}`);
    assert(!r.body.result?.isError, `${name}: ${toolText(r).slice(0, 300)}`);
    const text = toolText(r);
    return text ? JSON.parse(text) : null;
  }

  await test("mcp: read tools of every phase 1 area answer for a read-only token", async () => {
    const ro = await mint({ name: "smoke mcp phase1 reads" });
    try {
      const h = auth(ro);
      const reads = [
        ["tickets_list", { limit: 5 }],
        ["tickets_list", { status: ["open", "in_progress"], limit: 5 }],
        ["ticket_categories_list", {}],
        ["notes_list", {}],
        ["tags_list", {}],
        ["saved_views_list", { resource: "ticket" }],
        ["activity_list", { limit: 5 }],
        ["notifications_list", { limit: 5 }],
        ["notifications_unread_count", {}],
        ["me_get_notification_prefs", {}],
        ["dashboard_get_home", {}],
        ["dashboard_get_home", { include: ["week"] }],
        ["checklists_list_events", { upcoming: true }],
        ["checklists_list_templates", {}],
        ["checklists_list_stations", {}],
        ["checklists_list_services", {}],
        ["checklists_my_open_tasks", {}],
        ["checklists_report_events", { limit: 5 }],
      ];
      for (const [name, args] of reads) await run(h, name, args);
      const home = await run(h, "dashboard_get_home", {});
      assert(home.user && home.service, "home snapshot shape");
    } finally {
      await revoke(ro);
    }
  });

  await test("mcp: a ticket and a note are created, changed and audited as the token", async () => {
    const full = await mint({ name: "smoke mcp phase1 writes", readOnly: false });
    let ticketId = null;
    let noteId = null;
    try {
      const h = auth(full);
      const me = await run(h, "me_get_profile", {});

      const ticket = await run(h, "tickets_create", { title: "smoke mcp ticket", description: "created by the MCP smoke test", priority: "low" });
      ticketId = ticket.id;
      assert(ticket.number > 0 && /\/tickets\//.test(ticket.url ?? ""), `ticket result: ${JSON.stringify(ticket).slice(0, 200)}`);

      const comment = await run(h, "tickets_add_comment", { id: ticketId, body: "comment from the MCP smoke test" });
      assert(comment.body.startsWith("comment from"), "comment body");
      const comments = await run(h, "tickets_list_comments", { id: ticketId });
      assert(comments.some((c) => c.id === comment.id), "comment not listed");

      const updated = await run(h, "tickets_update", { id: ticketId, status: "in_progress", assignedUserId: me.id });
      assert(updated.status === "in_progress" && updated.assignedUserId === me.id, "ticket update");

      const bulk = await run(h, "tickets_bulk_update", { ids: [ticketId], action: { kind: "set_status", status: "closed" } });
      assert(bulk.applied === 1, `bulk: ${JSON.stringify(bulk)}`);
      const got = await run(h, "tickets_get", { id: ticketId });
      assert(got.status === "closed", `status after bulk ${got.status}`);

      const noDelete = await call(h, "tickets_bulk_update", { ids: [ticketId], action: { kind: "delete" } });
      assert(noDelete.body.result?.isError === true, "bulk delete was accepted");

      // The change went through the real route, so the audit row names the token.
      const audit = await session("/api/v1/audit?action=ticket.create&limit=20");
      const rows = (await audit.res.json()).items ?? [];
      const row = rows.find((r) => r.resourceId === ticketId);
      assert(row, "no ticket.create audit row");
      assert(row.apiTokenName === "smoke mcp phase1 writes", `audit row not attributed to the token: ${row.apiTokenName}`);

      const note = await run(h, "notes_create", { title: "smoke mcp note", body: "x" });
      noteId = note.id;
      const archived = await run(h, "notes_update", { id: noteId, archived: true });
      assert(archived.archived === true, "note not archived");
      const active = await run(h, "notes_list", {});
      assert(!active.some((n) => n.id === noteId), "archived note still in the active list");
      const old = await run(h, "notes_list", { archived: true });
      assert(old.some((n) => n.id === noteId), "archived note missing from the archive");

      // Tags: replace semantics on the ticket.
      const tags = await run(h, "tags_list", {});
      if (tags.length > 0) {
        const set = await run(h, "tags_set_for_resource", { resourceType: "ticket", resourceId: ticketId, tagIds: [tags[0].id] });
        assert(Array.isArray(set), "tags_set_for_resource shape");
        await run(h, "tags_set_for_resource", { resourceType: "ticket", resourceId: ticketId, tagIds: [] });
      }
    } finally {
      // No delete tools by design: clean up through the browser session.
      if (ticketId) await session(`/api/v1/tickets/${ticketId}`, { method: "DELETE" });
      if (noteId) await session(`/api/v1/notes/${noteId}`, { method: "DELETE" });
      await revoke(full);
    }
  });

  await test("mcp: a notes-only token cannot reach tickets or checklists through the tools", async () => {
    const notes = await mint({ name: "smoke mcp notes only", modules: ["notes"], readOnly: false });
    try {
      const h = auth(notes);
      const t = await call(h, "tickets_list", {});
      assert(t.body.result?.isError === true, "notes-only token listed tickets");
      const c = await call(h, "checklists_list_events", {});
      assert(c.body.result?.isError === true, "notes-only token listed checklists");
      await run(h, "notes_list", {});
    } finally {
      await revoke(notes);
    }
  });
}
