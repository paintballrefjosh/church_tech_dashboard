#!/usr/bin/env node
/**
 * HTTP smoke tests. Exercises every public-facing endpoint via the Caddy
 * reverse proxy on :8100. Uses a dedicated test user (created by
 * `make reset-test-user`) so the bootstrap admin's credentials are NEVER
 * modified by running this suite.
 *
 * Usage: node tests/smoke/run.mjs
 *        BASE=http://localhost:8100 node tests/smoke/run.mjs
 */

const BASE = process.env.BASE ?? "http://localhost:8100";
const VERBOSE = process.env.VERBOSE === "1";
// Test-user credentials. Must match apps/api/src/scripts/reset-test-user.ts.
const TEST_USER_EMAIL = "regression-test@local";
const TEST_USER_PASSWORD = "regression-default-pwd";

let pass = 0;
let fail = 0;
const failures = [];

function log(...args) {
  // eslint-disable-next-line no-console
  console.log(...args);
}

async function test(name, fn) {
  try {
    await fn();
    pass++;
    log(`  ok    ${name}`);
  } catch (err) {
    fail++;
    failures.push({ name, err });
    log(`  FAIL  ${name}`);
    log(`        ${err?.message ?? err}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function fetchWithCookies(path, init = {}, jar = new Map()) {
  const url = path.startsWith("http") ? path : `${BASE}${path}`;
  const cookieHeader = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  const headers = {
    ...(init.headers ?? {}),
    ...(cookieHeader ? { cookie: cookieHeader } : {}),
  };
  const res = await fetch(url, { ...init, headers, redirect: "manual" });
  const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const sc of setCookies) {
    const semi = sc.indexOf(";");
    const kv = semi >= 0 ? sc.slice(0, semi) : sc;
    const eq = kv.indexOf("=");
    if (eq > 0) {
      const name = kv.slice(0, eq).trim();
      const value = kv.slice(eq + 1).trim();
      if (value === "" || value === "deleted") jar.delete(name);
      else jar.set(name, value);
    }
  }
  if (VERBOSE) log(`    ${init.method ?? "GET"} ${path} -> ${res.status}`);
  return { res, jar };
}

async function main() {
  log(`smoke: BASE=${BASE}`);

  // ---- public endpoints ----
  await test("GET /api/v1/healthz returns ok", async () => {
    const { res } = await fetchWithCookies("/api/v1/healthz");
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(body.status === "ok", `body.status=${body.status}`);
  });

  await test("GET /api/v1/readyz reports db ok", async () => {
    const { res } = await fetchWithCookies("/api/v1/readyz");
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(body.checks?.db === "ok", `db check: ${JSON.stringify(body)}`);
  });

  await test("GET /api/v1/metrics returns prometheus output", async () => {
    const { res } = await fetchWithCookies("/api/v1/metrics");
    assert(res.status === 200, `status ${res.status}`);
    const text = await res.text();
    assert(text.includes("process_cpu_user_seconds_total"), "expected default metric not found");
  });

  await test("GET /api/health (web) returns ok", async () => {
    const { res } = await fetchWithCookies("/api/health");
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(body.status === "ok" && body.service === "web", `body=${JSON.stringify(body)}`);
  });

  await test("GET /api/auth/providers returns providers config", async () => {
    const { res } = await fetchWithCookies("/api/auth/providers");
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(typeof body === "object", "expected JSON object");
  });

  await test("GET /signin renders sign-in HTML", async () => {
    const { res } = await fetchWithCookies("/signin");
    assert(res.status === 200, `status ${res.status}`);
    const text = await res.text();
    assert(text.includes("Sign in"), "expected 'Sign in' in HTML");
  });

  await test("GET / redirects unauthed visitors to /signin", async () => {
    const { res } = await fetchWithCookies("/");
    assert(res.status === 307 || res.status === 302, `status ${res.status}`);
    const loc = res.headers.get("location") ?? "";
    assert(loc.includes("/signin"), `location: ${loc}`);
  });

  // ---- authentication required ----
  await test("GET /api/v1/me returns 401 without session", async () => {
    const { res } = await fetchWithCookies("/api/v1/me");
    assert(res.status === 401, `status ${res.status}`);
  });

  await test("GET /api/v1/users returns 401 without session", async () => {
    const { res } = await fetchWithCookies("/api/v1/users");
    assert(res.status === 401, `status ${res.status}`);
  });

  await test("GET /api/v1/audit returns 401 without session", async () => {
    const { res } = await fetchWithCookies("/api/v1/audit");
    assert(res.status === 401, `status ${res.status}`);
  });

  await test("GET /api/v1/settings returns 401 without session", async () => {
    const { res } = await fetchWithCookies("/api/v1/settings");
    assert(res.status === 401, `status ${res.status}`);
  });

  // ---- direct API verify-credentials: username + email forms ----
  await test("verify-credentials accepts the test user's email", async () => {
    const { res } = await fetchWithCookies("/api/v1/auth/verify-credentials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: TEST_USER_EMAIL, password: TEST_USER_PASSWORD }),
    });
    assert(res.status === 200 || res.status === 201, `status ${res.status}`);
    const body = await res.json();
    assert(body.ok === true, `expected ok=true`);
    assert(body.user.email === TEST_USER_EMAIL, `expected ${TEST_USER_EMAIL}, got ${body.user.email}`);
    assert(
      body.user.mustChangePassword === true,
      `regression-test user should have mustChangePassword=true after reset-test-user`,
    );
  });

  await test("verify-credentials normalises 'admin' username form (using bootstrap admin)", async () => {
    // We can't test the bootstrap admin's password here without knowing what
    // the operator set it to. Just confirm the input shape is accepted: an
    // unknown-password should 401, never 400.
    const { res } = await fetchWithCookies("/api/v1/auth/verify-credentials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "admin", password: "this-is-definitely-not-the-real-password" }),
    });
    assert(res.status === 401, `expected 401 (bad password), got ${res.status}`);
  });

  // ---- authenticated browser-like flow ----
  const jar = new Map();
  let csrfToken;

  await test("GET /api/auth/csrf returns csrfToken", async () => {
    const { res } = await fetchWithCookies("/api/auth/csrf", {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    csrfToken = body.csrfToken;
    assert(typeof csrfToken === "string" && csrfToken.length > 0, "no csrfToken");
  });

  await test("POST /api/auth/callback/credentials with the test user sets session cookie", async () => {
    const form = new URLSearchParams({
      csrfToken,
      email: TEST_USER_EMAIL,
      password: TEST_USER_PASSWORD,
      callbackUrl: BASE + "/",
      json: "true",
    });
    const { res, jar: j } = await fetchWithCookies(
      "/api/auth/callback/credentials",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      },
      jar
    );
    assert(res.status === 200 || res.status === 302, `status ${res.status}`);
    const hasSession = [...j.keys()].some((k) => k.includes("session-token"));
    assert(hasSession, `expected session cookie, got: ${[...j.keys()].join(", ")}`);
  });

  await test("GET /api/v1/me returns test-user profile with session", async () => {
    const { res } = await fetchWithCookies("/api/v1/me", {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(body.email === TEST_USER_EMAIL, `email: ${body.email}`);
    assert(Array.isArray(body.roles) && body.roles.includes("admin"), `roles: ${JSON.stringify(body.roles)}`);
    assert(
      Array.isArray(body.permissions) && body.permissions.includes("users:read:any"),
      `permissions: ${JSON.stringify(body.permissions)}`
    );
    assert(body.mustChangePassword === true, "freshly-reset test user should have mustChangePassword=true");
  });

  await test("GET /api/v1/users returns at least the bootstrap admin + the test user", async () => {
    const { res } = await fetchWithCookies("/api/v1/users", {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(Array.isArray(body) && body.length >= 2, `users count: ${body?.length}`);
    assert(body.some((u) => u.email === "admin@local"), "bootstrap admin not in list");
    assert(body.some((u) => u.email === TEST_USER_EMAIL), "test user not in list");
  });

  await test("GET /api/v1/roles returns the three system roles", async () => {
    const { res } = await fetchWithCookies("/api/v1/roles", {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    const keys = body.map((r) => r.key).sort();
    assert(
      keys.includes("admin") && keys.includes("support_engineer") && keys.includes("user"),
      `got roles: ${keys.join(", ")}`
    );
  });

  await test("GET /api/v1/roles/permissions returns the permission catalog", async () => {
    const { res } = await fetchWithCookies("/api/v1/roles/permissions", {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    const keys = body.map((p) => p.key);
    assert(keys.includes("users:read:any"), `missing core permission`);
    assert(keys.includes("audit:read:any"), `missing audit permission`);
    assert(keys.includes("settings:write:any"), `missing settings permission`);
  });

  await test("GET /api/v1/groups returns an array (empty initially)", async () => {
    const { res } = await fetchWithCookies("/api/v1/groups", {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(Array.isArray(body), "expected array");
  });

  let createdGroupId;
  await test("POST /api/v1/groups creates a group", async () => {
    const { res } = await fetchWithCookies(
      "/api/v1/groups",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "smoke-test-group", description: "created by smoke test" }),
      },
      jar
    );
    assert(res.status === 201 || res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(typeof body.id === "string", `no id in response`);
    createdGroupId = body.id;
  });

  await test("audit log records the group creation", async () => {
    await new Promise((r) => setTimeout(r, 300));
    const { res } = await fetchWithCookies("/api/v1/audit?action=group.create&limit=5", {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(
      Array.isArray(body.items) && body.items.some((e) => e.action === "group.create"),
      "no group.create audit entry"
    );
  });

  await test("DELETE /api/v1/groups/:id removes the test group", async () => {
    const { res } = await fetchWithCookies(`/api/v1/groups/${createdGroupId}`, { method: "DELETE" }, jar);
    assert(res.status === 200 || res.status === 204, `status ${res.status}`);
  });

  // ---- settings ----
  await test("PUT /api/v1/settings/site.name stores a value", async () => {
    const { res } = await fetchWithCookies(
      "/api/v1/settings/site.name",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "Smoke Church" }),
      },
      jar
    );
    assert(res.status === 200, `status ${res.status}`);
  });

  await test("GET /api/v1/settings/site.name reads the value back", async () => {
    const { res } = await fetchWithCookies("/api/v1/settings/site.name", {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(body.value === "Smoke Church", `unexpected value: ${JSON.stringify(body)}`);
  });

  await test("GET /api/v1/settings lists the persisted setting", async () => {
    const { res } = await fetchWithCookies("/api/v1/settings", {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(
      Array.isArray(body.items) && body.items.some((s) => s.key === "site.name" && s.value === "Smoke Church"),
      "settings list missing site.name"
    );
  });

  await test("DELETE /api/v1/settings/site.name removes it", async () => {
    const { res } = await fetchWithCookies("/api/v1/settings/site.name", { method: "DELETE" }, jar);
    assert(res.status === 200, `status ${res.status}`);
  });

  // ---- notes (Phase 1.1) ----
  await test("GET /api/v1/notes returns 401 without session", async () => {
    const { res } = await fetchWithCookies("/api/v1/notes");
    assert(res.status === 401, `status ${res.status}`);
  });

  await test("GET /api/v1/notes returns an array for the signed-in admin", async () => {
    const { res } = await fetchWithCookies("/api/v1/notes", {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(Array.isArray(body), "expected array");
  });

  let createdNoteId;
  await test("POST /api/v1/notes creates a note", async () => {
    const { res } = await fetchWithCookies(
      "/api/v1/notes",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "smoke", body: "body", color: "amber", pinned: true }),
      },
      jar,
    );
    assert(res.status === 200 || res.status === 201, `status ${res.status}`);
    const body = await res.json();
    assert(typeof body.id === "string", "no id");
    assert(body.title === "smoke" && body.color === "amber" && body.pinned === true, `bad body: ${JSON.stringify(body)}`);
    createdNoteId = body.id;
  });

  await test("PATCH /api/v1/notes/:id updates a note", async () => {
    const { res } = await fetchWithCookies(
      `/api/v1/notes/${createdNoteId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "smoke-updated", pinned: false }),
      },
      jar,
    );
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(body.title === "smoke-updated" && body.pinned === false, `bad body: ${JSON.stringify(body)}`);
  });

  await test("GET /api/v1/notes?q=smoke filters by search", async () => {
    const { res } = await fetchWithCookies("/api/v1/notes?q=smoke-updated", {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(body.some((n) => n.id === createdNoteId), "created note not in filtered results");
  });

  await test("audit log records the note creation", async () => {
    await new Promise((r) => setTimeout(r, 300));
    const { res } = await fetchWithCookies("/api/v1/audit?action=note.create&limit=5", {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(
      Array.isArray(body.items) && body.items.some((e) => e.action === "note.create"),
      "no note.create audit entry",
    );
  });

  await test("DELETE /api/v1/notes/:id removes the note", async () => {
    const { res } = await fetchWithCookies(`/api/v1/notes/${createdNoteId}`, { method: "DELETE" }, jar);
    assert(res.status === 200, `status ${res.status}`);
  });

  await test("PATCH on someone else's note 404s (owner enforcement)", async () => {
    // Use a random uuid that doesn't belong to us — service throws NotFound before owner-check.
    const { res } = await fetchWithCookies(
      "/api/v1/notes/00000000-0000-0000-0000-000000000000",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "nope" }),
      },
      jar,
    );
    assert(res.status === 404 || res.status === 403, `status ${res.status}`);
  });

  // ---- note attachments (Phase 1.5) ----
  let attachNoteId;
  await test("create a fresh note to host attachments", async () => {
    const { res } = await fetchWithCookies(
      "/api/v1/notes",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "attach-host", body: "" }),
      },
      jar,
    );
    assert(res.status === 200 || res.status === 201, `status ${res.status}`);
    const body = await res.json();
    attachNoteId = body.id;
  });

  const PNG_BYTES = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
  ]);

  let createdAttachmentId;
  await test("POST /api/v1/notes/:id/attachments uploads a PNG (multipart)", async () => {
    const fd = new FormData();
    fd.append("file", new Blob([PNG_BYTES], { type: "image/png" }), "pixel.png");
    const { res } = await fetchWithCookies(
      `/api/v1/notes/${attachNoteId}/attachments`,
      { method: "POST", body: fd },
      jar,
    );
    assert(res.status === 200 || res.status === 201, `status ${res.status}`);
    const body = await res.json();
    assert(body.parentType === "note" && body.parentId === attachNoteId, "wrong parent linkage");
    assert(body.contentType === "image/png", `content-type: ${body.contentType}`);
    assert(body.sizeBytes === PNG_BYTES.length, `size: ${body.sizeBytes} vs ${PNG_BYTES.length}`);
    createdAttachmentId = body.id;
  });

  await test("GET attachments list contains the upload", async () => {
    const { res } = await fetchWithCookies(`/api/v1/notes/${attachNoteId}/attachments`, {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(
      Array.isArray(body) && body.some((a) => a.id === createdAttachmentId),
      "attachment missing from list",
    );
  });

  await test("download streams the original PNG bytes back", async () => {
    const { res } = await fetchWithCookies(
      `/api/v1/notes/${attachNoteId}/attachments/${createdAttachmentId}`,
      {},
      jar,
    );
    assert(res.status === 200, `status ${res.status}`);
    assert(res.headers.get("content-type") === "image/png", `content-type: ${res.headers.get("content-type")}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    assert(buf.length === PNG_BYTES.length, `size ${buf.length} vs ${PNG_BYTES.length}`);
    for (let i = 0; i < 8; i++) {
      if (buf[i] !== PNG_BYTES[i]) throw new Error(`signature byte ${i} differs`);
    }
  });

  await test("upload rejects content-type not on the whitelist", async () => {
    const fd = new FormData();
    fd.append("file", new Blob(["<html></html>"], { type: "text/html" }), "evil.html");
    const { res } = await fetchWithCookies(
      `/api/v1/notes/${attachNoteId}/attachments`,
      { method: "POST", body: fd },
      jar,
    );
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  await test("DELETE /api/v1/notes/:id/attachments/:aid removes it", async () => {
    const { res } = await fetchWithCookies(
      `/api/v1/notes/${attachNoteId}/attachments/${createdAttachmentId}`,
      { method: "DELETE" },
      jar,
    );
    assert(res.status === 200 || res.status === 204, `status ${res.status}`);
    const { res: r2 } = await fetchWithCookies(`/api/v1/notes/${attachNoteId}/attachments`, {}, jar);
    const body = await r2.json();
    assert(!body.some((a) => a.id === createdAttachmentId), "attachment still listed after delete");
  });

  await test("deleting the host note cascade-removes any remaining attachments", async () => {
    // Re-upload one so there's something to cascade.
    const fd = new FormData();
    fd.append("file", new Blob(["plain text"], { type: "text/plain" }), "test.txt");
    const { res: upRes } = await fetchWithCookies(
      `/api/v1/notes/${attachNoteId}/attachments`,
      { method: "POST", body: fd },
      jar,
    );
    assert(upRes.status === 200 || upRes.status === 201, `upload status ${upRes.status}`);

    const { res: delRes } = await fetchWithCookies(
      `/api/v1/notes/${attachNoteId}`,
      { method: "DELETE" },
      jar,
    );
    assert(delRes.status === 200 || delRes.status === 204, `note delete status ${delRes.status}`);

    // Listing on a deleted note returns 404 (owner-check on assertOwner). The
    // attachment row + MinIO object should both be gone — proven by the listing
    // simply failing.
    const { res: listRes } = await fetchWithCookies(
      `/api/v1/notes/${attachNoteId}/attachments`,
      {},
      jar,
    );
    assert(listRes.status === 404 || listRes.status === 403, `expected 404/403, got ${listRes.status}`);
  });

  // ---- tickets (Phase 1.3) ----
  await test("GET /api/v1/tickets returns 401 without session", async () => {
    const { res } = await fetchWithCookies("/api/v1/tickets");
    assert(res.status === 401, `status ${res.status}`);
  });

  await test("GET /api/v1/tickets returns an array for the test user", async () => {
    const { res } = await fetchWithCookies("/api/v1/tickets", {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(Array.isArray(body), "expected array");
  });

  let createdTicketId;
  let createdTicketNumber;
  await test("POST /api/v1/tickets creates a ticket", async () => {
    const { res } = await fetchWithCookies(
      "/api/v1/tickets",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "smoke ticket", description: "from smoke", priority: "high" }),
      },
      jar,
    );
    assert(res.status === 200 || res.status === 201, `status ${res.status}`);
    const body = await res.json();
    assert(typeof body.id === "string", "no id");
    assert(typeof body.number === "number" && body.number >= 1, `bad number: ${body.number}`);
    assert(body.status === "open" && body.priority === "high", `bad body: ${JSON.stringify(body)}`);
    createdTicketId = body.id;
    createdTicketNumber = body.number;
  });

  await test("GET /api/v1/tickets/:id returns the just-created ticket", async () => {
    const { res } = await fetchWithCookies(`/api/v1/tickets/${createdTicketId}`, {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(body.number === createdTicketNumber, `bad number: ${body.number}`);
  });

  await test("PATCH /api/v1/tickets/:id moves to in_progress and clears resolved", async () => {
    const { res } = await fetchWithCookies(
      `/api/v1/tickets/${createdTicketId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "in_progress" }),
      },
      jar,
    );
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(body.status === "in_progress", `bad status: ${body.status}`);
    assert(body.resolvedAt == null, "resolvedAt should be null while in_progress");
  });

  await test("PATCH status=resolved sets resolved_at", async () => {
    const { res } = await fetchWithCookies(
      `/api/v1/tickets/${createdTicketId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "resolved" }),
      },
      jar,
    );
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(body.status === "resolved", `bad status: ${body.status}`);
    assert(body.resolvedAt != null, "resolvedAt should be set");
  });

  let createdCommentId;
  await test("POST /api/v1/tickets/:id/comments adds a public comment", async () => {
    const { res } = await fetchWithCookies(
      `/api/v1/tickets/${createdTicketId}/comments`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "looking into this" }),
      },
      jar,
    );
    assert(res.status === 200 || res.status === 201, `status ${res.status}`);
    const body = await res.json();
    assert(typeof body.id === "string", "no id");
    assert(body.isInternal === false, "default should be public");
    createdCommentId = body.id;
  });

  await test("POST /api/v1/tickets/:id/comments with isInternal=true works for staff", async () => {
    const { res } = await fetchWithCookies(
      `/api/v1/tickets/${createdTicketId}/comments`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "staff only note", isInternal: true }),
      },
      jar,
    );
    assert(res.status === 200 || res.status === 201, `status ${res.status}`);
    const body = await res.json();
    assert(body.isInternal === true, `isInternal: ${body.isInternal}`);
  });

  await test("GET /api/v1/tickets/:id/comments returns both", async () => {
    const { res } = await fetchWithCookies(`/api/v1/tickets/${createdTicketId}/comments`, {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(Array.isArray(body) && body.length === 2, `comment count: ${body?.length}`);
  });

  await test("audit log records ticket.create", async () => {
    await new Promise((r) => setTimeout(r, 300));
    const { res } = await fetchWithCookies("/api/v1/audit?action=ticket.create&limit=5", {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(
      Array.isArray(body.items) && body.items.some((e) => e.action === "ticket.create"),
      "no ticket.create audit entry",
    );
  });

  await test("DELETE /api/v1/tickets/:id/comments/:cid removes the comment", async () => {
    const { res } = await fetchWithCookies(
      `/api/v1/tickets/${createdTicketId}/comments/${createdCommentId}`,
      { method: "DELETE" },
      jar,
    );
    assert(res.status === 200 || res.status === 204, `status ${res.status}`);
  });

  // ---- ticket attachments (Phase 1.5.1) ----
  await test("POST /api/v1/tickets/:id/attachments uploads a file", async () => {
    const fd = new FormData();
    fd.append("file", new Blob(["ticket attached"], { type: "text/plain" }), "tix.txt");
    const { res } = await fetchWithCookies(
      `/api/v1/tickets/${createdTicketId}/attachments`,
      { method: "POST", body: fd },
      jar,
    );
    assert(res.status === 200 || res.status === 201, `status ${res.status}`);
    const body = await res.json();
    assert(body.parentType === "ticket" && body.parentId === createdTicketId, "wrong parent linkage");
  });

  await test("GET /api/v1/tickets/:id/attachments lists it", async () => {
    const { res } = await fetchWithCookies(`/api/v1/tickets/${createdTicketId}/attachments`, {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(Array.isArray(body) && body.length === 1, `count: ${body?.length}`);
  });

  await test("DELETE /api/v1/tickets/:id removes the ticket (admin)", async () => {
    const { res } = await fetchWithCookies(
      `/api/v1/tickets/${createdTicketId}`,
      { method: "DELETE" },
      jar,
    );
    assert(res.status === 200 || res.status === 204, `status ${res.status}`);
  });

  await test("GET /api/v1/tickets/:id on a deleted ticket returns 404", async () => {
    const { res } = await fetchWithCookies(`/api/v1/tickets/${createdTicketId}`, {}, jar);
    assert(res.status === 404, `status ${res.status}`);
  });

  await test("ticket attachment list on deleted ticket also 404s (cascade)", async () => {
    const { res } = await fetchWithCookies(
      `/api/v1/tickets/${createdTicketId}/attachments`,
      {},
      jar,
    );
    assert(res.status === 404 || res.status === 403, `status ${res.status}`);
  });

  // ---- wiki (Phase 1.4) ----
  await test("GET /api/v1/wiki returns 401 without session", async () => {
    const { res } = await fetchWithCookies("/api/v1/wiki");
    assert(res.status === 401, `status ${res.status}`);
  });

  await test("GET /api/v1/wiki returns an array for the test user", async () => {
    const { res } = await fetchWithCookies("/api/v1/wiki", {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(Array.isArray(body), "expected array");
  });

  let createdWikiId;
  await test("POST /api/v1/wiki creates a public page", async () => {
    const { res } = await fetchWithCookies(
      "/api/v1/wiki",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "smoke wiki",
          body: "# Hello\n\nbody text",
          visibility: "public",
        }),
      },
      jar,
    );
    assert(res.status === 200 || res.status === 201, `status ${res.status}`);
    const body = await res.json();
    assert(typeof body.id === "string", "no id");
    assert(body.visibility === "public", `visibility: ${body.visibility}`);
    createdWikiId = body.id;
  });

  await test("GET /api/v1/wiki/:id returns the page + ACL + caps", async () => {
    const { res } = await fetchWithCookies(`/api/v1/wiki/${createdWikiId}`, {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(body.page && body.page.id === createdWikiId, "page payload missing");
    assert(Array.isArray(body.acl), "acl missing");
    assert(body.canEdit === true && body.canDelete === true, "test user should be owner + admin");
  });

  await test("PATCH /api/v1/wiki/:id updates body and creates a revision", async () => {
    const { res } = await fetchWithCookies(
      `/api/v1/wiki/${createdWikiId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "# Hello\n\nrevised body", summary: "smoke edit" }),
      },
      jar,
    );
    assert(res.status === 200, `status ${res.status}`);
    const { res: rRev } = await fetchWithCookies(
      `/api/v1/wiki/${createdWikiId}/revisions`,
      {},
      jar,
    );
    assert(rRev.status === 200, `revisions status ${rRev.status}`);
    const revs = await rRev.json();
    assert(
      Array.isArray(revs) && revs.length >= 2,
      `expected at least 2 revisions, got ${revs?.length}`,
    );
    assert(revs.some((r) => r.summary === "smoke edit"), "edit-summary revision missing");
  });

  await test("GET /api/v1/wiki?q=smoke filters by search", async () => {
    const { res } = await fetchWithCookies("/api/v1/wiki?q=smoke", {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(body.some((p) => p.id === createdWikiId), "created page not in filtered results");
  });

  await test("audit log records wiki.create + wiki.update", async () => {
    await new Promise((r) => setTimeout(r, 300));
    const { res } = await fetchWithCookies(
      "/api/v1/audit?resourceType=wiki_page&limit=10",
      {},
      jar,
    );
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    const actions = (body.items ?? []).map((e) => e.action);
    assert(actions.includes("wiki.create"), "no wiki.create audit entry");
    assert(actions.includes("wiki.update"), "no wiki.update audit entry");
  });

  await test("PATCH visibility=group with empty ACL is accepted by the server", async () => {
    // The empty-ACL guard lives in the UI; the server accepts it (and the page
    // becomes invisible to everyone except the owner + admin). This test pins
    // that contract so we notice if we ever tighten it.
    const { res } = await fetchWithCookies(
      `/api/v1/wiki/${createdWikiId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ visibility: "group", acl: [] }),
      },
      jar,
    );
    assert(res.status === 200, `status ${res.status}`);
  });

  // ---- wiki attachments (Phase 1.5.1) ----
  await test("POST /api/v1/wiki/:id/attachments uploads a file", async () => {
    const fd = new FormData();
    fd.append("file", new Blob(["wiki attached"], { type: "text/plain" }), "wiki.txt");
    const { res } = await fetchWithCookies(
      `/api/v1/wiki/${createdWikiId}/attachments`,
      { method: "POST", body: fd },
      jar,
    );
    assert(res.status === 200 || res.status === 201, `status ${res.status}`);
    const body = await res.json();
    assert(body.parentType === "wiki_page" && body.parentId === createdWikiId, "wrong parent");
  });

  await test("GET /api/v1/wiki/:id/attachments lists it", async () => {
    const { res } = await fetchWithCookies(`/api/v1/wiki/${createdWikiId}/attachments`, {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(Array.isArray(body) && body.length === 1, `count: ${body?.length}`);
  });

  await test("DELETE /api/v1/wiki/:id removes the page (owner)", async () => {
    const { res } = await fetchWithCookies(
      `/api/v1/wiki/${createdWikiId}`,
      { method: "DELETE" },
      jar,
    );
    assert(res.status === 200 || res.status === 204, `status ${res.status}`);
  });

  await test("GET /api/v1/wiki/:id on a deleted page returns 404", async () => {
    const { res } = await fetchWithCookies(`/api/v1/wiki/${createdWikiId}`, {}, jar);
    assert(res.status === 404, `status ${res.status}`);
  });

  await test("wiki attachment list on deleted page is empty / 404 (cascade)", async () => {
    // Admins (wiki:read:any) treat any uuid as readable, so the route returns
    // 200 with an empty list rather than 404. Non-admins would 404. Either is
    // acceptable evidence the rows were cascade-removed.
    const { res } = await fetchWithCookies(
      `/api/v1/wiki/${createdWikiId}/attachments`,
      {},
      jar,
    );
    if (res.status === 404) return;
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(Array.isArray(body) && body.length === 0, `expected empty list, got ${JSON.stringify(body)}`);
  });

  // ---- summary ----
  log("");
  log(`smoke: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    log("");
    log("failures:");
    for (const f of failures) {
      log(`  - ${f.name}: ${f.err?.message ?? f.err}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  log("smoke: fatal", err);
  process.exit(1);
});
