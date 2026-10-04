/**
 * API token smoke tests, run from run.mjs after the test user has cleared
 * the must-change-password gate. Bearer calls go out with a fresh, empty
 * cookie jar so the token alone authenticates them. Every token created
 * here is revoked before the block ends (tokens are never deleted, only
 * revoked, so revoked rows from past runs remain).
 */
export async function apiTokenTests({ test, assert, fetchWithCookies, jar }) {
  const json = (body) => ({
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const session = (path, init = {}) => fetchWithCookies(path, init, jar);
  const bearer = (token, path, init = {}) =>
    fetchWithCookies(path, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` } }, new Map());
  const createToken = async (body) => {
    const { res } = await session("/api/v1/me/api-tokens", { method: "POST", ...json(body) });
    const text = await res.text();
    assert(res.status === 201 || res.status === 200, `create status ${res.status}: ${text}`);
    return JSON.parse(text);
  };

  let me;
  let readToken; // default: read-only, all modules
  let notesToken; // read-write, notes only
  let noteId;

  await test("tokens: session can create a token; defaults to read-only", async () => {
    const meRes = await session("/api/v1/me");
    me = await meRes.res.json();
    readToken = await createToken({ name: "smoke read-only", expiresInDays: 1 });
    assert(readToken.token.startsWith("cdt_") && readToken.token.length >= 40, `bad token ${readToken.token?.slice(0, 8)}`);
    assert(readToken.prefix === readToken.token.slice(0, 8), `prefix ${readToken.prefix}`);
    assert(readToken.readOnly === true && readToken.modules === null, `bad limits ${JSON.stringify(readToken)}`);
    assert(readToken.status === "active" && readToken.userId === me.id, `bad summary ${JSON.stringify(readToken)}`);
  });

  await test("tokens: GET /me with the token returns its owner", async () => {
    const { res } = await bearer(readToken.token, "/api/v1/me");
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(body.email === me.email, `email ${body.email}`);
  });

  await test("tokens: listing never returns the secret", async () => {
    const { res } = await session("/api/v1/me/api-tokens");
    assert(res.status === 200, `status ${res.status}`);
    const text = await res.text();
    const list = JSON.parse(text);
    assert(list.some((t) => t.id === readToken.id), "new token not listed");
    assert(!text.includes(readToken.token) && !text.includes("tokenHash"), "list leaks the token or its hash");
  });

  await test("tokens: a read-only token gets 403 on a POST", async () => {
    const { res } = await bearer(readToken.token, "/api/v1/notes", { method: "POST", ...json({ title: "nope", body: "" }) });
    assert(res.status === 403, `status ${res.status}`);
  });

  await test("tokens: a bad bearer token is a 401 even alongside a valid session", async () => {
    const { res } = await fetchWithCookies("/api/v1/me", { headers: { authorization: "Bearer cdt_not-a-real-token" } }, jar);
    assert(res.status === 401, `status ${res.status}`);
  });

  await test("tokens: a read-write notes-only token can create a note", async () => {
    notesToken = await createToken({ name: "smoke notes rw", readOnly: false, modules: ["notes"], expiresInDays: 1 });
    const { res } = await bearer(notesToken.token, "/api/v1/notes", {
      method: "POST",
      ...json({ title: "smoke via token", body: "made with an API token", color: "amber", pinned: false }),
    });
    assert(res.status === 201 || res.status === 200, `status ${res.status}`);
    noteId = (await res.json()).id;
    assert(typeof noteId === "string", "no note id");
  });

  await test("tokens: a module-limited token gets 403 outside its modules", async () => {
    const { res } = await bearer(notesToken.token, "/api/v1/users");
    assert(res.status === 403, `status ${res.status}`);
  });

  await test("tokens: a token can't create or revoke tokens (session only)", async () => {
    const create = await bearer(notesToken.token, "/api/v1/me/api-tokens", { method: "POST", ...json({ name: "minted" }) });
    assert(create.res.status === 403, `create status ${create.res.status}`);
    const revoke = await bearer(notesToken.token, `/api/v1/me/api-tokens/${readToken.id}`, { method: "DELETE" });
    assert(revoke.res.status === 403, `revoke status ${revoke.res.status}`);
  });

  await test("tokens: a token can't change the password (session only)", async () => {
    const { res } = await bearer(notesToken.token, "/api/v1/me/change-password", {
      method: "POST",
      ...json({ newPassword: "token-takeover-attempt" }),
    });
    assert(res.status === 403, `status ${res.status}`);
  });

  await test("tokens: a change made with a token is audited with its id", async () => {
    await new Promise((r) => setTimeout(r, 300));
    const { res } = await session("/api/v1/audit?action=note.create&limit=20");
    assert(res.status === 200, `status ${res.status}`);
    const { items } = await res.json();
    const row = items.find((e) => e.resourceId === noteId);
    assert(row, "no audit row for the note");
    assert(row.apiTokenId === notesToken.id, `apiTokenId ${row.apiTokenId}`);
    assert(row.apiTokenName === "smoke notes rw", `apiTokenName ${row.apiTokenName}`);
  });

  await test("tokens: the create response's token is not in the audit log", async () => {
    const { res } = await session("/api/v1/audit?action=api_token.create&limit=20");
    assert(res.status === 200, `status ${res.status}`);
    const text = await res.text();
    const { items } = JSON.parse(text);
    assert(items.some((e) => e.resourceId === notesToken.id), "no api_token.create row");
    assert(!text.includes(notesToken.token) && !text.includes(readToken.token), "plaintext token found in audit log");
  });

  await test("tokens: delete the note made by token (cleanup)", async () => {
    const { res } = await bearer(notesToken.token, `/api/v1/notes/${noteId}`, { method: "DELETE" });
    assert(res.status === 200, `status ${res.status}`);
  });

  await test("tokens: create rejects unknown modules and over-long expiry", async () => {
    const bad = [
      { name: "x", modules: ["bogus"] },
      { name: "x", expiresInDays: 3650 },
      { name: "x", expiresAt: null },
      { name: "x", expiresAt: new Date(Date.now() - 60_000).toISOString() },
    ];
    for (const body of bad) {
      const { res } = await session("/api/v1/me/api-tokens", { method: "POST", ...json(body) });
      assert(res.status === 400, `${JSON.stringify(body)} -> ${res.status}`);
    }
  });

  await test("tokens: a revoked token gets 401", async () => {
    const { res } = await session(`/api/v1/me/api-tokens/${readToken.id}`, { method: "DELETE" });
    assert(res.status === 200, `revoke status ${res.status}`);
    const body = await res.json();
    assert(body.status === "revoked", `status ${body.status}`);
    const after = await bearer(readToken.token, "/api/v1/me");
    assert(after.res.status === 401, `status after revoke ${after.res.status}`);
  });

  await test("tokens: an expired token gets 401", async () => {
    const short = await createToken({ name: "smoke expiring", expiresAt: new Date(Date.now() + 2_000).toISOString() });
    await new Promise((r) => setTimeout(r, 3_000));
    const { res } = await bearer(short.token, "/api/v1/me");
    assert(res.status === 401, `status ${res.status}`);
  });

  await test("tokens: turning auth.api_tokens_enabled off stops existing tokens", async () => {
    const live = await createToken({ name: "smoke switch", expiresInDays: 1 });
    const setEnabled = (value) =>
      session("/api/v1/settings/auth.api_tokens_enabled", { method: "PUT", ...json({ value }) });
    try {
      const off = await setEnabled(false);
      assert(off.res.status === 200, `PUT setting status ${off.res.status}`);
      const blocked = await bearer(live.token, "/api/v1/me");
      assert(blocked.res.status === 401, `token while off: ${blocked.res.status}`);
      const create = await session("/api/v1/me/api-tokens", { method: "POST", ...json({ name: "while off" }) });
      assert(create.res.status === 403, `create while off: ${create.res.status}`);
    } finally {
      // Back to the default (on). The earlier token tests only pass with the
      // feature on, so this restores the operator's effective setting.
      await session("/api/v1/settings/auth.api_tokens_enabled", { method: "DELETE" });
      await session(`/api/v1/me/api-tokens/${live.id}`, { method: "DELETE" });
    }
    const back = await bearer(notesToken.token, "/api/v1/me");
    assert(back.res.status === 200, `token after switching back on: ${back.res.status}`);
  });

  let issued;
  await test("tokens: an admin can list everyone's tokens and issue one to a user", async () => {
    const list = await session(`/api/v1/admin/api-tokens?userId=${me.id}&status=active`);
    assert(list.res.status === 200, `list status ${list.res.status}`);
    const rows = await list.res.json();
    assert(rows.some((t) => t.id === notesToken.id && t.userEmail === me.email), "notes token missing from admin list");
    assert(!rows.some((t) => t.id === readToken.id), "revoked token in the active filter");
    const { res } = await session(`/api/v1/admin/users/${me.id}/api-tokens`, {
      method: "POST",
      ...json({ name: "smoke admin-issued", readOnly: false, modules: ["wiki"], expiresInDays: 1 }),
    });
    assert(res.status === 201 || res.status === 200, `issue status ${res.status}`);
    issued = await res.json();
    const check = await bearer(issued.token, "/api/v1/me");
    assert(check.res.status === 200, `issued token status ${check.res.status}`);
  });

  await test("tokens: revoke-all kills every live token for a user", async () => {
    const { res } = await session(`/api/v1/admin/users/${me.id}/api-tokens/revoke-all`, { method: "POST" });
    assert(res.status === 201 || res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(body.revoked >= 2, `revoked ${body.revoked}`);
    for (const t of [notesToken, issued]) {
      const after = await bearer(t.token, "/api/v1/me");
      assert(after.res.status === 401, `${t.name} still works: ${after.res.status}`);
    }
  });
}
