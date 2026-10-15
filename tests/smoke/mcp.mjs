/**
 * MCP server smoke tests (POST /api/v1/mcp), run from run.mjs. It creates short-lived API
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

  await test("mcp: files are attached to a ticket, note and wiki page, listed, read back and audited as the token", async () => {
    const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const full = await mint({ name: "smoke mcp attachments", readOnly: false });
    const ro = await mint({ name: "smoke mcp attachments ro" });
    let ticketId = null;
    let noteId = null;
    let pageId = null;
    try {
      const h = auth(full);
      ticketId = (await run(h, "tickets_create", { title: "smoke mcp attachments", description: "x", priority: "low" })).id;
      noteId = (await run(h, "notes_create", { title: "smoke mcp attachments", body: "x" })).id;
      pageId = (await run(h, "wiki_create_page", { title: "smoke mcp attachments" })).id;

      for (const [area, id] of [["tickets", ticketId], ["notes", noteId], ["wiki", pageId]]) {
        const added = await run(h, `${area}_add_attachment`, { id, filename: "smoke.txt", text: "smoke attachment text" });
        assert(added.filename === "smoke.txt" && added.contentType === "text/plain", `${area}: ${JSON.stringify(added)}`);
        const list = await run(h, `${area}_list_attachments`, { id });
        assert(list.some((a) => a.id === added.id), `${area}: attachment not listed`);

        const read = await call(h, `${area}_get_attachment`, { id, aid: added.id });
        assert(!read.body.result?.isError, `${area}: ${toolText(read).slice(0, 200)}`);
        const blocks = read.body.result.content;
        assert(JSON.parse(blocks[0].text).filename === "smoke.txt", `${area}: description block`);
        assert(blocks[1]?.type === "text" && blocks[1].text === "smoke attachment text", `${area}: text block ${JSON.stringify(blocks[1])}`);
      }

      // An image round trip: the bytes come back as an image block.
      const img = await run(h, "tickets_add_attachment", { id: ticketId, filename: "pixel.png", contentType: "image/png", contentBase64: PNG });
      assert(img.contentType === "image/png", `image upload: ${JSON.stringify(img)}`);
      const shown = await call(h, "tickets_get_attachment", { id: ticketId, aid: img.id });
      const block = shown.body.result.content[1];
      assert(block?.type === "image" && block.mimeType === "image/png" && block.data === PNG, "image not returned as an image block");

      // The route's own checks still apply: a type nobody allowed, and bytes that do not match the declared type.
      const exe = await call(h, "tickets_add_attachment", { id: ticketId, filename: "x.exe", contentType: "application/x-msdownload", text: "MZ" });
      assert(exe.body.result?.isError === true, "a disallowed type was accepted");
      const liar = await call(h, "tickets_add_attachment", { id: ticketId, filename: "x.png", contentType: "image/png", text: "this is not a png" });
      assert(liar.body.result?.isError === true, "text declared as png was accepted");
      const both = await call(h, "tickets_add_attachment", { id: ticketId, filename: "x.txt", text: "a", contentBase64: "YQ==" });
      assert(both.body.result?.isError === true, "text and base64 together were accepted");

      // Attributed to the token, like every other change (the row's resource id is the attachment's, the response's id).
      const audit = await session("/api/v1/audit?action=ticket.attachment.upload&limit=20");
      const row = ((await audit.res.json()).items ?? []).find((r) => r.resourceId === img.id);
      assert(row?.apiTokenName === "smoke mcp attachments", `upload not attributed to the token: ${row?.apiTokenName}`);

      // A read-only token reads but cannot add, and there is no delete tool.
      const hr = auth(ro);
      const names = (await rpc(hr, "tools/list")).body.result.tools.map((t) => t.name);
      assert(names.includes("tickets_get_attachment") && !names.includes("tickets_add_attachment"), "read-only tool list for attachments");
      assert(!names.some((n) => /delete_attachment|remove_attachment/.test(n)), "an attachment delete tool exists");
      const refused = await call(hr, "tickets_add_attachment", { id: ticketId, filename: "x.txt", text: "a" });
      assert(refused.body.result?.isError === true, "a read-only token added a file");
      const looked = await call(hr, "tickets_list_attachments", { id: ticketId });
      assert(!looked.body.result?.isError, "a read-only token could not list files");
    } finally {
      if (ticketId) await session(`/api/v1/tickets/${ticketId}`, { method: "DELETE" });
      if (noteId) await session(`/api/v1/notes/${noteId}`, { method: "DELETE" });
      if (pageId) await session(`/api/v1/wiki/${pageId}`, { method: "DELETE" });
      await revoke(full);
      await revoke(ro);
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

  // ---- Phase 2: monitoring and IT ----

  await test("mcp: monitoring and IT reads answer for a read-only token; integrations may be unconfigured but never crash", async () => {
    const ro = await mint({ name: "smoke mcp phase2 reads" });
    try {
      const h = auth(ro);
      // Held in the database: must answer.
      const stored = [
        ["monitors_list", {}],
        ["monitors_summary", {}],
        ["monitors_list_open_incidents", {}],
        ["monitors_list_workers", {}],
        ["monitors_get_maintenance", {}],
        ["health_get_services", {}],
        ["infra_get_summary", {}],
        ["infra_list_open_incidents", {}],
        ["infra_list_targets", {}],
        ["printers_list", {}],
        ["printers_get_summary", {}],
        ["ups_list", {}],
        ["ups_get_summary", {}],
        ["ipam_get_summary", {}],
        ["ipam_list_subnets", {}],
        ["cisco_list_switches", {}],
        ["cisco_get_backup_status", {}],
        ["cisco_list_backups", { limit: 5 }],
        ["cisco_list_drift", { limit: 5 }],
        ["cisco_list_mac", { limit: 5, sort: "ip" }],
        ["cisco_list_vlans", {}],
        ["cisco_get_topology", {}],
        ["cisco_lookup", { q: "00" }],
        ["dns_get_sync_status", {}],
        ["dns_list_sync_runs", {}],
      ];
      for (const [name, args] of stored) await run(h, name, args);

      // Outside systems: "not configured" or "unreachable" is a fine answer, an internal error is not.
      const outside = [
        ["unifi_get_health", {}],
        ["unifi_get_summary", {}],
        ["unifi_list_devices", {}],
        ["dns_get_summary", {}],
        ["dns_list_zones", {}],
        ["dns_get_stats", { range: "LastHour" }],
        ["planning_center_get_health", {}],
        ["planning_center_list_service_types", {}],
        ["planning_center_get_my_link", {}],
        ["propresenter_get_health", {}],
        ["propresenter_get_status", {}],
      ];
      for (const [name, args] of outside) {
        const r = await call(h, name, args);
        assert(r.status === 200, `${name}: HTTP ${r.status}`);
        // 502/503/504 is the outside system being down; a plain 500 is the dashboard failing.
        assert(!/HTTP 500/.test(toolText(r)), `${name}: server error: ${toolText(r).slice(0, 200)}`);
      }

      // Drill into the first row of a few lists.
      const monitors = await run(h, "monitors_list", {});
      if (monitors.length > 0) {
        await run(h, "monitors_get", { id: monitors[0].id });
        await run(h, "monitors_get_history", { id: monitors[0].id, limit: 5 });
        await run(h, "monitors_list_incidents", { id: monitors[0].id });
      }
      const targets = await run(h, "infra_list_targets", {});
      if (targets.length > 0) {
        await run(h, "infra_get_target", { id: targets[0].id });
        await run(h, "infra_list_entities", { id: targets[0].id });
        await run(h, "infra_get_metrics", { id: targets[0].id });
      }
      const subnets = await run(h, "ipam_list_subnets", {});
      if (subnets.length > 0) await run(h, "ipam_list_hosts", { id: subnets[0].id });
    } finally {
      await revoke(ro);
    }
  });

  await test("mcp: a monitor is created, changed and audited as the token, and its stored header stays hidden", async () => {
    const full = await mint({ name: "smoke mcp phase2 writes", readOnly: false });
    let monitorId = null;
    try {
      const h = auth(full);
      // Created switched off, so the probe worker never touches it and no incident or alert can result.
      const created = await run(h, "monitors_create", {
        name: "smoke mcp monitor",
        kind: "http",
        target: "http://127.0.0.1:9/",
        enabled: false,
        options: { method: "GET", authorization: "Bearer smoke-secret-value" },
      });
      monitorId = created.id;
      assert(created.options?.authorization === "[hidden]", `header not hidden: ${JSON.stringify(created.options)}`);
      assert(/\/monitoring\//.test(created.url ?? ""), "no link");
      const got = await run(h, "monitors_get", { id: monitorId });
      assert(got.name === "smoke mcp monitor" && got.enabled === false, "monitor read back");
      assert(!JSON.stringify(got).includes("smoke-secret-value"), "secret leaked through monitors_get");
      const all = await run(h, "monitors_list", {});
      assert(!JSON.stringify(all).includes("smoke-secret-value"), "secret leaked through monitors_list");

      const renamed = await run(h, "monitors_update", { id: monitorId, name: "smoke mcp monitor renamed" });
      assert(renamed.name === "smoke mcp monitor renamed", "monitor rename");

      // Maintenance mode: write the state it already has, so nothing changes for anyone else.
      const before = await run(h, "monitors_get_maintenance", {});
      const same = await run(h, "monitors_set_maintenance", { enabled: before.enabled });
      assert(same.enabled === before.enabled, "maintenance changed");

      // The audit snapshot of the create holds the header; the agent's view of the log must not.
      const viaTool = await run(h, "audit_list", { action: "monitor.create", limit: 20 });
      assert(viaTool.items.some((r) => r.resourceId === monitorId), "audit_list does not show the monitor.create row");
      assert(!JSON.stringify(viaTool).includes("smoke-secret-value"), "secret leaked through audit_list");
      const audit = await session("/api/v1/audit?action=monitor.create&limit=20");
      const row = ((await audit.res.json()).items ?? []).find((r) => r.resourceId === monitorId);
      assert(row, "no monitor.create audit row");
      // The route itself (what a web admin reads) holds no secret either: the writer scrubs the stored snapshot.
      assert(!JSON.stringify(row).includes("smoke-secret-value"), "secret stored in the audit snapshot");
      assert(row.apiTokenName === "smoke mcp phase2 writes", `audit row not attributed to the token: ${row.apiTokenName}`);
    } finally {
      if (monitorId) await session(`/api/v1/monitors/${monitorId}`, { method: "DELETE" });
      await revoke(full);
    }
  });

  // ---- Phase 3: the operational token level ----

  const EQUIPMENT_TOOLS = [
    "propresenter_next",
    "propresenter_clear",
    "cisco_toggle_port",
    "cisco_push_drift",
    "dns_create_record",
    "dns_run_sync",
    "ipam_scan_subnet",
    "ups_poll",
  ];
  const NEVER_TOOLS = [
    "monitors_delete",
    "infra_create_target",
    "infra_update_target",
    "printers_create",
    "ups_create",
    "cisco_create_switch",
    "dns_delete_record",
    "dns_test_connection",
  ];
  // A UUID nothing has: the guard and the argument check run, the handler answers "not found" and touches no equipment.
  const NOBODY = "00000000-0000-4000-8000-000000000000";

  await test("mcp: equipment tools are listed only to a token with the operational level", async () => {
    const write = await mint({ name: "smoke mcp phase3 write", readOnly: false });
    const op = await mint({ name: "smoke mcp phase3 operational", readOnly: false, allowOperational: true });
    try {
      assert(op.allowOperational === true && write.allowOperational === false, "level not reported on the token");
      const namesOf = async (t) => ((await rpc(auth(t), "tools/list")).body?.result?.tools ?? []).map((x) => x.name);
      const writeNames = await namesOf(write);
      const opNames = await namesOf(op);
      for (const n of EQUIPMENT_TOOLS) {
        assert(!writeNames.includes(n), `${n} is offered to a write token`);
        assert(opNames.includes(n), `${n} is missing for an operational token`);
      }
      for (const n of NEVER_TOOLS) {
        assert(!writeNames.includes(n) && !opNames.includes(n), `${n} is offered`);
      }
      assert(opNames.length > writeNames.length, "operational token should see more tools");
    } finally {
      await revoke(write);
      await revoke(op);
    }
  });

  await test("mcp: a write token is refused an equipment tool by name, an operational token reaches it", async () => {
    const write = await mint({ name: "smoke mcp phase3 refused", readOnly: false });
    const op = await mint({ name: "smoke mcp phase3 reached", readOnly: false, allowOperational: true });
    try {
      const refused = await call(auth(write), "ups_poll", { id: NOBODY });
      assert(refused.body.result?.isError === true && /operational level/.test(toolText(refused)), `not refused: ${toolText(refused)}`);
      const reached = await call(auth(op), "ups_poll", { id: NOBODY });
      assert(reached.body.result?.isError === true && /Not found/.test(toolText(reached)), `unexpected: ${toolText(reached)}`);
    } finally {
      await revoke(write);
      await revoke(op);
    }
  });

  await test("tokens: the operational level is enforced on the REST routes too, and a read-only token cannot have it", async () => {
    const write = await mint({ name: "smoke rest phase3 write", readOnly: false });
    const op = await mint({ name: "smoke rest phase3 operational", readOnly: false, allowOperational: true });
    try {
      const post = (t) =>
        fetchWithCookies(`/api/v1/ups/${NOBODY}/poll`, { method: "POST", headers: { ...auth(t), "content-type": "application/json" }, body: "{}" }, new Map());
      const refused = await post(write);
      assert(refused.res.status === 403, `write token: HTTP ${refused.res.status}`);
      assert(/operational/.test(JSON.stringify(await refused.res.json())), "403 does not say why");
      const reached = await post(op);
      assert(reached.res.status === 404, `operational token: HTTP ${reached.res.status}`);

      const bad = await session("/api/v1/me/api-tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "smoke bad level", readOnly: true, allowOperational: true, expiresInDays: 1 }),
      });
      assert(bad.res.status === 400, `read-only operational token: HTTP ${bad.res.status}`);
    } finally {
      await revoke(write);
      await revoke(op);
    }
  });

  // ---- Phase 4: read-only admin ----

  await test("mcp: read-only admin tools answer, and no secret reaches the model", async () => {
    const ro = await mint({ name: "smoke mcp phase4 reads" });
    try {
      const h = auth(ro);
      const users = await run(h, "users_list", {});
      assert(Array.isArray(users) && users.length > 0, "users_list");
      assert(!/passwordHash|totpSecret/i.test(JSON.stringify(users)), "credential field in users_list");
      await run(h, "users_get", { id: users[0].id });
      await run(h, "users_get_groups", { id: users[0].id });
      const groups = await run(h, "groups_list", {});
      assert(Array.isArray(groups) && groups.length > 0, "groups_list");
      await run(h, "groups_get", { id: groups[0].id });
      await run(h, "groups_list_members", { id: groups[0].id });
      await run(h, "groups_get_module_access", { id: groups[0].id });
      await run(h, "groups_get_permissions", { id: groups[0].id });
      await run(h, "groups_get_matrix", {});
      await run(h, "audit_list", { limit: 5 });
      await run(h, "cluster_get_status", {});

      // Every secret setting that is set reads [hidden]; none shows its value. Compare with what the session sees.
      const settings = await run(h, "settings_list", {});
      assert(Array.isArray(settings.items) && settings.items.length > 0, "settings_list");
      const real = await session("/api/v1/settings");
      const realItems = (await real.res.json()).items ?? [];
      for (const it of realItems) {
        if (!/secret|password|token|api_key|community/i.test(it.key)) continue;
        if (typeof it.value !== "string" || it.value === "") continue; // a secret is text; a number or flag is not one
        const seen = settings.items.find((x) => x.key === it.key);
        assert(seen?.value === "[hidden]", `${it.key} is not hidden: ${JSON.stringify(seen?.value)}`);
      }
      const one = await run(h, "settings_get", { key: "site.name" });
      assert(one.key === "site.name", "settings_get");
    } finally {
      await revoke(ro);
    }
  });

  await test("mcp: a token without admin modules gets no admin data", async () => {
    const notes = await mint({ name: "smoke mcp phase4 notes only", modules: ["notes"], readOnly: false });
    try {
      const h = auth(notes);
      const names = ((await rpc(h, "tools/list")).body?.result?.tools ?? []).map((t) => t.name);
      for (const n of ["users_list", "groups_list", "audit_list", "cluster_get_status"]) {
        assert(!names.includes(n), `${n} is offered to a notes-only token`);
      }
      const s = await run(h, "settings_list", {});
      assert((s.items ?? []).every((i) => !/^(smtp|auth|google|microsoft)\./.test(i.key)), "core settings visible to a notes-only token");
    } finally {
      await revoke(notes);
    }
  });
}
