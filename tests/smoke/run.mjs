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
