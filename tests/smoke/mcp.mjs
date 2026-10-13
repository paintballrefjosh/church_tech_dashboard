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
}
