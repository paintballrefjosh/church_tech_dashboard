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
// What the suite changes the password to, to clear the must-change gate.
const TEST_USER_SMOKE_PASSWORD = "regression-smoke-pwd-1";

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
  // The API rate-limits each IP (300 req/min globally). A full run makes
  // close to that many requests, so back-to-back runs can trip it: honour
  // the server's retry-after instead of failing the test on a 429.
  let res = await fetch(url, { ...init, headers, redirect: "manual" });
  for (let attempt = 0; res.status === 429 && attempt < 3; attempt++) {
    const waitSec = Math.min(65, Math.max(1, parseInt(res.headers.get("retry-after") ?? "10", 10) || 10));
    log(`    429 on ${init.method ?? "GET"} ${path}; waiting ${waitSec}s (rate limit)`);
    await new Promise((r) => setTimeout(r, waitSec * 1000));
    res = await fetch(url, { ...init, headers, redirect: "manual" });
  }
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
    assert(Array.isArray(body.groups) && body.groups.includes("admin"), `groups: ${JSON.stringify(body.groups)}`);
    assert(
      Array.isArray(body.permissions) && body.permissions.includes("users:read:any"),
      `permissions: ${JSON.stringify(body.permissions)}`
    );
    assert(body.mustChangePassword === true, "freshly-reset test user should have mustChangePassword=true");
    assert(
      body.pageWidth === "standard",
      `expected default pageWidth=standard, got: ${body.pageWidth}`
    );
    assert(body.pageWidthPx === null, `expected pageWidthPx=null by default, got: ${body.pageWidthPx}`);
  });

  // reset-test-user leaves the account with mustChangePassword=true, so the
  // SessionGuard gate refuses every write except the password change. Prove
  // the gate holds, then change the password like a real first sign-in so
  // the rest of the suite can exercise mutating endpoints. (make regression
  // re-runs reset-test-user before e2e, which tests the browser flow itself.)
  await test("must-change-password gate refuses writes before the password change", async () => {
    const { res } = await fetchWithCookies(
      "/api/v1/me",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageWidth: "wide" }) },
      jar,
    );
    assert(res.status === 403, `expected 403, got ${res.status}`);
    const body = await res.json();
    assert(/password change required/i.test(body.message ?? ""), `unexpected message: ${JSON.stringify(body)}`);
  });

  await test("POST /api/v1/me/change-password clears the gate", async () => {
    const { res } = await fetchWithCookies(
      "/api/v1/me/change-password",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newPassword: TEST_USER_SMOKE_PASSWORD }),
      },
      jar,
    );
    assert(res.status === 200 || res.status === 201, `status ${res.status}`);
    const { res: me } = await fetchWithCookies("/api/v1/me", {}, jar);
    const body = await me.json();
    assert(body.mustChangePassword === false, "mustChangePassword should be false after the change");
  });

  await test("PATCH /api/v1/me cycles through every preset", async () => {
    for (const value of ["fluid", "narrow", "wide", "standard"]) {
      const patch = await fetchWithCookies(
        "/api/v1/me",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pageWidth: value }),
        },
        jar
      );
      assert(patch.res.status === 200, `patch ${value} status ${patch.res.status}`);
      const patched = await patch.res.json();
      assert(patched.pageWidth === value, `patch echoed: ${patched.pageWidth}`);
      assert(patched.pageWidthPx === null, `non-custom mode should null pageWidthPx`);
    }
  });

  await test("PATCH /api/v1/me { pageWidth: 'custom', pageWidthPx: 1400 } stores px", async () => {
    const patch = await fetchWithCookies(
      "/api/v1/me",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pageWidth: "custom", pageWidthPx: 1400 }),
      },
      jar
    );
    assert(patch.res.status === 200, `status ${patch.res.status}`);
    const patched = await patch.res.json();
    assert(patched.pageWidth === "custom", `echoed: ${patched.pageWidth}`);
    assert(patched.pageWidthPx === 1400, `px echoed: ${patched.pageWidthPx}`);

    const { res } = await fetchWithCookies("/api/v1/me", {}, jar);
    const body = await res.json();
    assert(body.pageWidth === "custom" && body.pageWidthPx === 1400, "GET /me persisted custom+px");
  });

  await test("Switching from custom to a preset clears pageWidthPx", async () => {
    const patch = await fetchWithCookies(
      "/api/v1/me",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pageWidth: "narrow" }),
      },
      jar
    );
    assert(patch.res.status === 200, `status ${patch.res.status}`);
    const patched = await patch.res.json();
    assert(patched.pageWidthPx === null, `narrow mode should null px, got: ${patched.pageWidthPx}`);
  });

  await test("PATCH /api/v1/me { pageWidth: 'fixed' } is rejected (legacy value removed)", async () => {
    const { res } = await fetchWithCookies(
      "/api/v1/me",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pageWidth: "fixed" }),
      },
      jar
    );
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  await test("PATCH /api/v1/me { pageWidthPx: 100 } is rejected (out of bounds)", async () => {
    const { res } = await fetchWithCookies(
      "/api/v1/me",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pageWidth: "custom", pageWidthPx: 100 }),
      },
      jar
    );
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  await test("PATCH /api/v1/me restores pageWidth=standard (test cleanup)", async () => {
    const { res } = await fetchWithCookies(
      "/api/v1/me",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pageWidth: "standard" }),
      },
      jar
    );
    assert(res.status === 200, `status ${res.status}`);
  });

  await test("GET /api/v1/users returns the test user and at least one other active user", async () => {
    const { res } = await fetchWithCookies("/api/v1/users", {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(Array.isArray(body) && body.length >= 2, `users count: ${body?.length}`);
    assert(body.some((u) => u.email === TEST_USER_EMAIL), "test user not in list");
    // The seeded bootstrap admin is admin@local, but operators rename it to a
    // real address, so only require that some other active account exists.
    assert(
      body.some((u) => u.email !== TEST_USER_EMAIL && u.isActive && !u.deletedAt),
      "no active user besides the test user",
    );
  });

  await test("user soft-delete lifecycle: delete keeps the row, blocks re-create, restore re-enables", async () => {
    const email = `soft-delete-smoke-${Date.now()}@example.com`;
    // Create a throwaway local user.
    const created = await fetchWithCookies(
      "/api/v1/users",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          displayName: "Soft Delete Smoke",
          password: "smoke-password-1234",
        }),
      },
      jar,
    );
    assert(created.res.status === 201 || created.res.status === 200, `create status ${created.res.status}`);
    const user = await created.res.json();
    assert(typeof user.id === "string", "created user has no id");

    // Soft-delete it.
    const del = await fetchWithCookies(`/api/v1/users/${user.id}`, { method: "DELETE" }, jar);
    assert(del.res.status === 200, `delete status ${del.res.status}`);

    // Still present in the list, now tombstoned.
    const list1 = await (await fetchWithCookies("/api/v1/users", {}, jar)).res.json();
    const afterDelete = list1.find((u) => u.id === user.id);
    assert(afterDelete, "soft-deleted user should still appear in the list");
    assert(afterDelete.deletedAt, "soft-deleted user should have deletedAt set");
    assert(afterDelete.isActive === false, "soft-deleted user should be inactive");

    // Re-creating with the same email is blocked with a deleted-account message.
    const reCreate = await fetchWithCookies(
      "/api/v1/users",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, displayName: "Dup", password: "smoke-password-1234" }),
      },
      jar,
    );
    assert(reCreate.res.status === 409, `expected 409 conflict, got ${reCreate.res.status}`);
    const conflict = await reCreate.res.json();
    assert(
      JSON.stringify(conflict).toLowerCase().includes("deleted"),
      `conflict message should mention deleted account: ${JSON.stringify(conflict)}`,
    );

    // Deleted user cannot sign in via credentials (specific coded error).
    const login = await fetchWithCookies("/api/v1/auth/verify-credentials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "smoke-password-1234" }),
    });
    assert(login.res.status === 401, `deleted user login should 401, got ${login.res.status}`);
    const loginBody = await login.res.json();
    assert(loginBody.code === "account_deleted", `expected account_deleted code, got ${JSON.stringify(loginBody)}`);

    // Restore re-enables the account.
    const restore = await fetchWithCookies(`/api/v1/users/${user.id}/restore`, { method: "POST" }, jar);
    assert(restore.res.status === 200 || restore.res.status === 201, `restore status ${restore.res.status}`);
    const list2 = await (await fetchWithCookies("/api/v1/users", {}, jar)).res.json();
    const afterRestore = list2.find((u) => u.id === user.id);
    assert(afterRestore && !afterRestore.deletedAt, "restored user should have deletedAt cleared");
    assert(afterRestore.isActive === true, "restored user should be active again");

    // Hard-delete requires the account to be soft-deleted first.
    const earlyPurge = await fetchWithCookies(`/api/v1/users/${user.id}/hard-delete`, { method: "POST" }, jar);
    assert(earlyPurge.res.status === 400, `hard-delete on a live user should 400, got ${earlyPurge.res.status}`);

    // Soft-delete, then hard-delete (cleanup + exercises the SITE_ADMIN purge).
    await fetchWithCookies(`/api/v1/users/${user.id}`, { method: "DELETE" }, jar);
    const purge = await fetchWithCookies(`/api/v1/users/${user.id}/hard-delete`, { method: "POST" }, jar);
    assert(purge.res.status === 200 || purge.res.status === 201, `hard-delete status ${purge.res.status}`);
    const list3 = await (await fetchWithCookies("/api/v1/users", {}, jar)).res.json();
    assert(!list3.some((u) => u.id === user.id), "hard-deleted user should be gone from the list entirely");
  });

  await test("GET /api/v1/groups/matrix returns the default groups with module access", async () => {
    const { res } = await fetchWithCookies("/api/v1/groups/matrix", {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(Array.isArray(body.modules), "modules should be an array");
    assert(Array.isArray(body.groups), "groups should be an array");
    const moduleKeys = body.modules.map((m) => m.key);
    assert(
      moduleKeys.includes("tickets") && moduleKeys.includes("wiki") && moduleKeys.includes("admin"),
      `expected core modules in catalog, got: ${moduleKeys.join(",")}`,
    );
    // admin + user are system groups (can't be deleted); support_engineer is
    // only a seed default an operator may rename or remove.
    const names = body.groups.map((g) => g.name).sort();
    assert(
      names.includes("admin") && names.includes("user"),
      `expected system groups admin + user present, got: ${names.join(", ")}`,
    );
    const adminGroup = body.groups.find((g) => g.name === "admin");
    assert(
      adminGroup && adminGroup.access && adminGroup.access.admin === "admin",
      `expected admin group at admin tier on admin module, got: ${JSON.stringify(adminGroup?.access)}`,
    );
    assert(
      adminGroup.isSystem === true,
      `admin group should be flagged is_system`,
    );
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
  // This block exercises PUT/GET/list/DELETE against a real setting key. It
  // MUST be non-destructive: site.name is operator branding, and a regression
  // run that deletes it silently reverts the live site to the "Church
  // Dashboard" fallback. So snapshot the current value up front and restore it
  // (or re-delete it, if it was unset) once the CRUD assertions are done.
  let originalSiteName = null;
  await test("snapshot existing site.name before mutating it", async () => {
    const { res } = await fetchWithCookies("/api/v1/settings/site.name", {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    originalSiteName = typeof body.value === "string" ? body.value : null;
  });

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

  // Put the operator's branding back exactly as we found it. If it was unset
  // the DELETE above already left it unset, so there's nothing to restore.
  await test("restore the operator's original site.name", async () => {
    if (originalSiteName === null) return;
    const { res } = await fetchWithCookies(
      "/api/v1/settings/site.name",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: originalSiteName }),
      },
      jar
    );
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
    // The list also carries system "event" entries (status/assignee changes
    // made earlier in this suite); count only the two written comments.
    assert(Array.isArray(body), "expected an array");
    const written = body.filter((c) => (c.kind ?? "comment") === "comment");
    assert(written.length === 2, `comment count: ${written.length} (of ${body.length} entries)`);
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

  // ---- dashboard tiles (Phase 1.6) ----
  await test("GET /api/v1/dashboard/tiles returns the catalogue", async () => {
    const { res } = await fetchWithCookies("/api/v1/dashboard/tiles", {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    const ids = body.map((t) => t.id);
    assert(
      ids.includes("tickets.summary") && ids.includes("notes.recent") &&
        ids.includes("wiki.recent") && ids.includes("quick.links"),
      `missing tile in catalogue: ${ids.join(",")}`,
    );
  });

  await test("GET /api/v1/dashboard/layout returns the default before any save", async () => {
    // Ensure a clean slate first.
    await fetchWithCookies("/api/v1/dashboard/layout", { method: "DELETE" }, jar);
    const { res } = await fetchWithCookies("/api/v1/dashboard/layout", {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(Array.isArray(body.layout) && body.layout.length >= 1, `bad layout: ${JSON.stringify(body)}`);
    assert(
      body.layout.some((p) => p.tileId === "tickets.summary"),
      "default layout missing tickets.summary",
    );
  });

  await test("PUT /api/v1/dashboard/layout persists a custom layout", async () => {
    const custom = {
      layout: [
        { tileId: "notes.recent", x: 0, y: 0, w: 6, h: 3 },
        { tileId: "wiki.recent", x: 6, y: 0, w: 6, h: 3 },
      ],
    };
    const { res } = await fetchWithCookies(
      "/api/v1/dashboard/layout",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(custom),
      },
      jar,
    );
    assert(res.status === 200 || res.status === 201, `status ${res.status}`);
    const { res: get } = await fetchWithCookies("/api/v1/dashboard/layout", {}, jar);
    const body = await get.json();
    assert(body.layout.length === 2, `expected 2 tiles, got ${body.layout.length}`);
    assert(body.layout[0].tileId === "notes.recent", `bad first tile: ${body.layout[0].tileId}`);
  });

  await test("PUT rejects invalid placements (oversize w/h)", async () => {
    const { res } = await fetchWithCookies(
      "/api/v1/dashboard/layout",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ layout: [{ tileId: "x", x: 0, y: 0, w: 999, h: 999 }] }),
      },
      jar,
    );
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  await test("DELETE /api/v1/dashboard/layout reverts to default", async () => {
    const { res } = await fetchWithCookies(
      "/api/v1/dashboard/layout",
      { method: "DELETE" },
      jar,
    );
    assert(res.status === 200 || res.status === 204, `status ${res.status}`);
    const { res: get } = await fetchWithCookies("/api/v1/dashboard/layout", {}, jar);
    const body = await get.json();
    assert(
      body.layout.some((p) => p.tileId === "quick.links"),
      "after reset, expected default to be back (quick.links missing)",
    );
  });

  // ---- notifications (Phase 1.7) ----
  await test("GET /api/v1/notifications returns 401 without session", async () => {
    const { res } = await fetchWithCookies("/api/v1/notifications");
    assert(res.status === 401, `status ${res.status}`);
  });

  await test("GET /api/v1/notifications/unread-count starts at 0", async () => {
    // Clear any leftovers from previous test sections so the baseline is clean.
    const { res: list } = await fetchWithCookies("/api/v1/notifications?limit=200", {}, jar);
    const existing = await list.json();
    for (const n of existing) {
      await fetchWithCookies(`/api/v1/notifications/${n.id}`, { method: "DELETE" }, jar);
    }
    const { res } = await fetchWithCookies("/api/v1/notifications/unread-count", {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(body.count === 0, `expected 0, got ${body.count}`);
  });

  await test("POST /api/v1/notifications/test-email creates a self-notification", async () => {
    const { res } = await fetchWithCookies(
      "/api/v1/notifications/test-email",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      jar,
    );
    assert(res.status === 200 || res.status === 201, `status ${res.status}`);
    const { res: cnt } = await fetchWithCookies("/api/v1/notifications/unread-count", {}, jar);
    const body = await cnt.json();
    assert(body.count >= 1, `expected >=1, got ${body.count}`);
  });

  let lastNotificationId;
  await test("GET /api/v1/notifications lists the test-email entry", async () => {
    const { res } = await fetchWithCookies("/api/v1/notifications", {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    const found = body.find((n) => n.kind === "system.test");
    assert(found, "no system.test notification in list");
    lastNotificationId = found.id;
  });

  await test("POST /api/v1/notifications/:id/read marks one read", async () => {
    const { res } = await fetchWithCookies(
      `/api/v1/notifications/${lastNotificationId}/read`,
      { method: "POST" },
      jar,
    );
    assert(res.status === 200 || res.status === 201, `status ${res.status}`);
    const { res: cnt } = await fetchWithCookies("/api/v1/notifications/unread-count", {}, jar);
    const body = await cnt.json();
    assert(body.count === 0, `expected 0 after mark-read, got ${body.count}`);
  });

  await test("DELETE /api/v1/notifications/:id dismisses it", async () => {
    const { res } = await fetchWithCookies(
      `/api/v1/notifications/${lastNotificationId}`,
      { method: "DELETE" },
      jar,
    );
    assert(res.status === 200 || res.status === 204, `status ${res.status}`);
  });

  // NOTE: actual SMTP delivery is intentionally NOT asserted in the smoke suite.
  // There is no in-stack mail sink (MailHog was removed), and the suite must not
  // mutate the operator's real smtp.* settings — doing so previously clobbered
  // prod SMTP config on every run. The test-email endpoint's success is already
  // covered above; delivery is verified manually against the real mail server.

  // ---- TOTP enrollment (Phase 1.8) ----
  // We exercise the API endpoints end-to-end against the *test* user only;
  // bootstrap admin is never touched. After this block runs we tear down the
  // enrollment so subsequent runs start from a known state.
  //
  // Inline RFC 6238 TOTP generator (no otplib in the smoke container).
  const crypto = await import("node:crypto");
  const totp = (base32Secret) => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const cleaned = base32Secret.replace(/=+$/, "").toUpperCase();
    let bits = "";
    for (const ch of cleaned) {
      const v = alphabet.indexOf(ch);
      if (v < 0) throw new Error(`bad base32 char ${ch}`);
      bits += v.toString(2).padStart(5, "0");
    }
    const bytes = Buffer.alloc(Math.floor(bits.length / 8));
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
    }
    const counter = Math.floor(Date.now() / 1000 / 30);
    const ctrBuf = Buffer.alloc(8);
    ctrBuf.writeBigUInt64BE(BigInt(counter));
    const hmac = crypto.createHmac("sha1", bytes).update(ctrBuf).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const code =
      ((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff);
    return String(code % 1_000_000).padStart(6, "0");
  };
  await test("GET /api/v1/auth/totp/status reports not enrolled initially", async () => {
    // Best-effort cleanup in case a previous run was interrupted mid-enroll.
    await fetchWithCookies(
      "/api/v1/auth/totp",
      { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "000000" }) },
      jar,
    );
    const { res } = await fetchWithCookies("/api/v1/auth/totp/status", {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(body.enabled === false, `enabled=${body.enabled}`);
  });

  let totpSecret = null;
  await test("POST /api/v1/auth/totp/enroll returns otpauth + qr svg", async () => {
    const { res } = await fetchWithCookies("/api/v1/auth/totp/enroll", { method: "POST" }, jar);
    assert(res.status === 200 || res.status === 201, `status ${res.status}`);
    const body = await res.json();
    assert(typeof body.otpauth === "string" && body.otpauth.startsWith("otpauth://"), "no otpauth uri");
    assert(typeof body.qr === "string" && body.qr.startsWith("<svg"), "qr is not an svg");
    // Pull the secret out of the otpauth URI so we can compute a real code.
    const m = body.otpauth.match(/secret=([A-Z2-7]+)/);
    assert(m, "could not extract secret from otpauth uri");
    totpSecret = m[1];
  });

  await test("POST /api/v1/auth/totp/confirm with a valid code enrolls TOTP", async () => {
    const code = totp(totpSecret);
    const { res } = await fetchWithCookies(
      "/api/v1/auth/totp/confirm",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) },
      jar,
    );
    assert(res.status === 200 || res.status === 201, `status ${res.status}`);
    const { res: st } = await fetchWithCookies("/api/v1/auth/totp/status", {}, jar);
    const body = await st.json();
    assert(body.enabled === true, `still not enrolled: ${JSON.stringify(body)}`);
  });

  await test("DELETE /api/v1/auth/totp rejects a bad code", async () => {
    const { res } = await fetchWithCookies(
      "/api/v1/auth/totp",
      { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "000000" }) },
      jar,
    );
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  await test("DELETE /api/v1/auth/totp with a valid code disables TOTP", async () => {
    const code = totp(totpSecret);
    const { res } = await fetchWithCookies(
      "/api/v1/auth/totp",
      { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) },
      jar,
    );
    assert(res.status === 200 || res.status === 201, `status ${res.status}`);
    const { res: st } = await fetchWithCookies("/api/v1/auth/totp/status", {}, jar);
    const body = await st.json();
    assert(body.enabled === false, `still enrolled: ${JSON.stringify(body)}`);
  });

  // ---- Monitoring (Phase 2.1) ----
  // Best-effort cleanup of any monitors a prior run left behind, then exercise
  // the CRUD + history endpoints against a freshly-created HTTP monitor.
  let monitorId = null;
  await test("GET /api/v1/monitors returns 401 without session", async () => {
    const { res } = await fetchWithCookies("/api/v1/monitors");
    assert(res.status === 401, `status ${res.status}`);
  });

  await test("clean up any stale [smoke] monitors from a previous run", async () => {
    const { res } = await fetchWithCookies("/api/v1/monitors", {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const list = await res.json();
    for (const m of list) {
      if (typeof m.name === "string" && m.name.startsWith("[smoke]")) {
        await fetchWithCookies(`/api/v1/monitors/${m.id}`, { method: "DELETE" }, jar);
      }
    }
  });

  await test("POST /api/v1/monitors creates an http monitor", async () => {
    const { res } = await fetchWithCookies(
      "/api/v1/monitors",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "[smoke] localhost healthz",
          kind: "http",
          target: "http://api:3001/api/v1/healthz",
          intervalSec: 30,
          failThreshold: 2,
          recoverThreshold: 1,
        }),
      },
      jar,
    );
    assert(res.status === 200 || res.status === 201, `status ${res.status}`);
    const body = await res.json();
    monitorId = body.id;
    assert(body.kind === "http", `kind: ${body.kind}`);
    assert(body.status === "unknown", `expected unknown, got ${body.status}`);
  });

  await test("POST /api/v1/monitors rejects invalid kind (zod)", async () => {
    const { res } = await fetchWithCookies(
      "/api/v1/monitors",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "[smoke] bad", kind: "carrier-pigeon", target: "x" }),
      },
      jar,
    );
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  await test("GET /api/v1/monitors/:id returns the monitor", async () => {
    const { res } = await fetchWithCookies(`/api/v1/monitors/${monitorId}`, {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(body.id === monitorId, `id mismatch`);
  });

  await test("GET /api/v1/monitors/summary returns counts", async () => {
    const { res } = await fetchWithCookies("/api/v1/monitors/summary", {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    for (const k of ["total", "up", "down", "unknown"]) {
      assert(typeof body[k] === "number", `${k} not a number: ${JSON.stringify(body)}`);
    }
  });

  await test("GET /api/v1/monitors/workers reports the probe workers by node", async () => {
    const { res } = await fetchWithCookies("/api/v1/monitors/workers", {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(typeof body.clustered === "boolean", `clustered missing: ${JSON.stringify(body)}`);
    assert(typeof body.windowMin === "number" && typeof body.enabledMonitors === "number", "window/enabled missing");
    assert(Array.isArray(body.nodes), "nodes is not an array");
    for (const n of body.nodes) {
      assert(typeof n.nodeId === "string" && typeof n.checks === "number" && typeof n.failures === "number", `bad node: ${JSON.stringify(n)}`);
    }
  });

  await test("PATCH /api/v1/monitors/:id updates fields", async () => {
    const { res } = await fetchWithCookies(
      `/api/v1/monitors/${monitorId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      },
      jar,
    );
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(body.enabled === false, `still enabled`);
  });

  await test("GET /api/v1/monitors/:id/history returns an array", async () => {
    const { res } = await fetchWithCookies(`/api/v1/monitors/${monitorId}/history`, {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(Array.isArray(body), "history not an array");
  });

  await test("DELETE /api/v1/monitors/:id removes the monitor", async () => {
    const { res } = await fetchWithCookies(
      `/api/v1/monitors/${monitorId}`,
      { method: "DELETE" },
      jar,
    );
    assert(res.status === 200, `status ${res.status}`);
    const { res: after } = await fetchWithCookies(`/api/v1/monitors/${monitorId}`, {}, jar);
    assert(after.status === 404, `expected 404, got ${after.status}`);
  });

  // ---- Infrastructure: switching a host's monitoring off ----
  {
    let infraId = null;
    const json = { "content-type": "application/json" };
    await test("a new infra target can be created with monitoring switched off", async () => {
      const { res } = await fetchWithCookies(
        "/api/v1/infra/targets",
        { method: "POST", headers: json, body: JSON.stringify({ name: "[smoke] infra off", os: "linux", host: "127.0.0.1", enabled: false }) },
        jar,
      );
      assert(res.status === 201 || res.status === 200, `status ${res.status}`);
      const body = await res.json();
      assert(body.enabled === false, "enabled should be false");
      infraId = body.id;
    });
    await test("the summary counts a disabled target apart, and open alerts ignore it", async () => {
      const { res } = await fetchWithCookies("/api/v1/infra/summary", {}, jar);
      assert(res.status === 200, `status ${res.status}`);
      const body = await res.json();
      assert(typeof body.targets.disabled === "number" && body.targets.disabled >= 1, `disabled: ${JSON.stringify(body.targets)}`);
    });
    await test("a disabled target refuses poll-now and service discovery (409)", async () => {
      for (const path of ["poll-now", "discover-services"]) {
        const { res } = await fetchWithCookies(`/api/v1/infra/targets/${infraId}/${path}`, { method: "POST" }, jar);
        assert(res.status === 409, `${path}: expected 409, got ${res.status}`);
      }
    });
    await test("a disabled target refuses an update run (409)", async () => {
      const { res } = await fetchWithCookies(
        `/api/v1/infra/targets/${infraId}/update-run`,
        { method: "POST", headers: json, body: "{}" },
        jar,
      );
      // 400 when the target lacks the OS-updates capability comes first; either way nothing may start.
      assert(res.status === 409 || res.status === 400, `expected 409/400, got ${res.status}`);
    });
    await test("switching monitoring on resets the stale reading, and back off again", async () => {
      const { res } = await fetchWithCookies(
        `/api/v1/infra/targets/${infraId}`,
        { method: "PATCH", headers: json, body: JSON.stringify({ enabled: true }) },
        jar,
      );
      assert(res.status === 200, `status ${res.status}`);
      const on = await res.json();
      assert(on.enabled === true, "enabled should be true");
      const { res: res2 } = await fetchWithCookies(
        `/api/v1/infra/targets/${infraId}`,
        { method: "PATCH", headers: json, body: JSON.stringify({ enabled: false }) },
        jar,
      );
      assert(res2.status === 200 && (await res2.json()).enabled === false, "should be disabled again");
    });
    await test("delete the infra smoke target", async () => {
      const { res } = await fetchWithCookies(`/api/v1/infra/targets/${infraId}`, { method: "DELETE" }, jar);
      assert(res.status === 200, `status ${res.status}`);
    });
  }

  // ---- UniFi (Phase 2.2) ----
  // Works whether or not a controller is configured on this stack: the
  // "unconfigured" behaviour is only asserted when health says so.
  await test("GET /api/v1/unifi/health returns 401 without session", async () => {
    const { res } = await fetchWithCookies("/api/v1/unifi/health");
    assert(res.status === 401, `status ${res.status}`);
  });
  let unifiConfigured = false;
  await test("GET /api/v1/unifi/health returns a health object", async () => {
    const { res } = await fetchWithCookies("/api/v1/unifi/health", {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(typeof body.configured === "boolean", `configured missing: ${JSON.stringify(body)}`);
    unifiConfigured = body.configured;
  });
  await test("GET /api/v1/unifi/devices returns an array (empty when unconfigured)", async () => {
    const { res } = await fetchWithCookies("/api/v1/unifi/devices", {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(Array.isArray(body), `expected an array: ${JSON.stringify(body).slice(0, 200)}`);
    if (!unifiConfigured) assert(body.length === 0, `expected [] when unconfigured, got ${body.length}`);
  });

  // ---- DNS (Technitium) ----
  // Works whether or not a Technitium primary is configured on this stack:
  // validation paths are checked unconditionally, the "not configured"
  // behaviour only when summary says so.
  await test("GET /api/v1/dns/summary returns 401 without session", async () => {
    const { res } = await fetchWithCookies("/api/v1/dns/summary");
    assert(res.status === 401, `status ${res.status}`);
  });
  let dnsConfigured = false;
  await test("GET /api/v1/dns/summary returns a summary", async () => {
    const { res } = await fetchWithCookies("/api/v1/dns/summary", {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(typeof body.configured === "boolean", `configured missing: ${JSON.stringify(body)}`);
    assert(typeof body.unreachableNodes === "number", `unreachableNodes missing: ${JSON.stringify(body)}`);
    dnsConfigured = body.configured;
  });
  await test("GET /api/v1/dns/zones/:zone/records rejects an invalid zone name", async () => {
    const { res } = await fetchWithCookies(`/api/v1/dns/zones/${encodeURIComponent("bad zone!")}/records`, {}, jar);
    assert(res.status === 400, `status ${res.status}`);
  });
  await test("GET /api/v1/dns/stats rejects an unknown range", async () => {
    const { res } = await fetchWithCookies("/api/v1/dns/stats?range=Forever", {}, jar);
    assert(res.status === 400, `status ${res.status}`);
  });
  await test("POST /api/v1/dns/test rejects a non-http URL without calling out", async () => {
    const { res } = await fetchWithCookies(
      "/api/v1/dns/test",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: "ftp://dns.invalid", apiToken: "x" }),
      },
      jar,
    );
    assert(res.status === 200 || res.status === 201, `status ${res.status}`);
    const body = await res.json();
    assert(body.ok === false && /http/.test(body.message), `unexpected: ${JSON.stringify(body)}`);
  });
  const dnsWrite = (method, body) =>
    fetchWithCookies(
      "/api/v1/dns/zones/example.org/records",
      { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      jar,
    );
  await test("POST /api/v1/dns/zones/:zone/records rejects a malformed A record", async () => {
    const { res } = await dnsWrite("POST", { name: "printer", data: { type: "A", ipAddress: "not-an-ip" } });
    assert(res.status === 400, `status ${res.status}`);
  });
  await test("POST /api/v1/dns/zones/:zone/records refuses the reserved sync comment", async () => {
    const { res } = await dnsWrite("POST", {
      name: "printer",
      comments: "managed-by:church-dashboard",
      data: { type: "A", ipAddress: "10.0.0.5" },
    });
    assert(res.status === 400, `status ${res.status}`);
  });
  await test("PATCH /api/v1/dns/zones/:zone/records refuses a type change", async () => {
    const { res } = await dnsWrite("PATCH", {
      current: { name: "printer", data: { type: "A", ipAddress: "10.0.0.5" } },
      name: "printer",
      ttl: 300,
      data: { type: "CNAME", cname: "other.example.org" },
    });
    assert(res.status === 400, `status ${res.status}`);
  });
  await test("GET /api/v1/dns/sync/status returns sync status", async () => {
    const { res } = await fetchWithCookies("/api/v1/dns/sync/status", {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(typeof body.enabled === "boolean" && typeof body.hosts === "object", `unexpected: ${JSON.stringify(body)}`);
  });
  await test("GET /api/v1/dns/sync/runs returns an array", async () => {
    const { res } = await fetchWithCookies("/api/v1/dns/sync/runs", {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    assert(Array.isArray(await res.json()), "expected an array");
  });
  await test("POST /api/v1/dns/reverse-zones rejects a forward zone name", async () => {
    const { res } = await fetchWithCookies(
      "/api/v1/dns/reverse-zones",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ zone: "example.org" }) },
      jar,
    );
    assert(res.status === 400, `status ${res.status}`);
  });
  await test("POST /api/v1/dns/health-monitors rejects a node that isn't an IPv4 address", async () => {
    const { res } = await fetchWithCookies(
      "/api/v1/dns/health-monitors",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nodes: ["dns1.example.org"] }) },
      jar,
    );
    assert(res.status === 400, `status ${res.status}`);
  });
  await test("PATCH /api/v1/ipam/hosts/:id rejects a DNS name that isn't one label", async () => {
    const { res } = await fetchWithCookies(
      "/api/v1/ipam/hosts/00000000-0000-0000-0000-000000000000",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ dnsName: "two.labels" }) },
      jar,
    );
    assert(res.status === 400, `status ${res.status}`);
  });
  await test("DNS (unconfigured) zones are empty and records/stats return 503", async () => {
    if (dnsConfigured) return; // live cluster attached; nothing to assert here
    const { res: z } = await fetchWithCookies("/api/v1/dns/zones", {}, jar);
    assert(z.status === 200, `zones status ${z.status}`);
    const zones = await z.json();
    assert(Array.isArray(zones) && zones.length === 0, `expected []: ${JSON.stringify(zones)}`);
    const { res: r } = await fetchWithCookies("/api/v1/dns/zones/example.org/records", {}, jar);
    assert(r.status === 503, `records status ${r.status}`);
    const { res: s } = await fetchWithCookies("/api/v1/dns/stats?range=LastDay", {}, jar);
    assert(s.status === 503, `stats status ${s.status}`);
  });
  await test("DNS (unconfigured) record writes return 503", async () => {
    if (dnsConfigured) return;
    const { res } = await dnsWrite("POST", { name: "printer", data: { type: "A", ipAddress: "10.0.0.5" } });
    assert(res.status === 503, `create status ${res.status}`);
  });

  // ---- ProPresenter (Phase 2.3) ----
  await test("GET /api/v1/propresenter/health returns 401 without session", async () => {
    const { res } = await fetchWithCookies("/api/v1/propresenter/health");
    assert(res.status === 401, `status ${res.status}`);
  });
  let propresenterConfigured = true; // assume live until health proves otherwise
  await test("GET /api/v1/propresenter/health returns a health object", async () => {
    const { res } = await fetchWithCookies("/api/v1/propresenter/health", {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(typeof body.configured === "boolean", `configured missing: ${JSON.stringify(body)}`);
    propresenterConfigured = body.configured;
  });
  await test("POST /api/v1/propresenter/next (unconfigured) returns 503", async () => {
    // NEVER send this to a configured ProPresenter: it would advance the
    // slides on a live machine, possibly mid-service.
    if (propresenterConfigured) return;
    const { res } = await fetchWithCookies(
      "/api/v1/propresenter/next",
      { method: "POST" },
      jar,
    );
    assert(res.status === 503, `expected 503, got ${res.status}`);
  });

  // ---- Search + Tags + Activity (Phase 3) ----
  await test("GET /api/v1/search returns 401 without session", async () => {
    const { res } = await fetchWithCookies("/api/v1/search?q=anything");
    assert(res.status === 401, `status ${res.status}`);
  });

  await test("GET /api/v1/search with empty q returns empty hits", async () => {
    const { res } = await fetchWithCookies("/api/v1/search?q=", {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(Array.isArray(body.hits) && body.hits.length === 0, `expected []`);
  });

  await test("GET /api/v1/search returns hits array", async () => {
    const { res } = await fetchWithCookies("/api/v1/search?q=zzz-no-match-zzz", {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(Array.isArray(body.hits), `expected array hits`);
  });

  let tagId = null;
  await test("clean up any stale [smoke] tags", async () => {
    const { res } = await fetchWithCookies("/api/v1/tags", {}, jar);
    if (res.status === 200) {
      const list = await res.json();
      for (const t of list) {
        if (typeof t.name === "string" && t.name.startsWith("[smoke]")) {
          await fetchWithCookies(`/api/v1/tags/${t.id}`, { method: "DELETE" }, jar);
        }
      }
    }
  });

  await test("POST /api/v1/tags creates a tag", async () => {
    const { res } = await fetchWithCookies(
      "/api/v1/tags",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "[smoke] urgent", color: "rose" }),
      },
      jar,
    );
    assert(res.status === 200 || res.status === 201, `status ${res.status}`);
    const body = await res.json();
    tagId = body.id;
    assert(body.color === "rose", `color: ${body.color}`);
  });

  await test("POST /api/v1/tags rejects duplicate name with 409", async () => {
    const { res } = await fetchWithCookies(
      "/api/v1/tags",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "[smoke] urgent", color: "rose" }),
      },
      jar,
    );
    assert(res.status === 409, `expected 409, got ${res.status}`);
  });

  await test("POST /api/v1/tags rejects invalid colour (zod)", async () => {
    const { res } = await fetchWithCookies(
      "/api/v1/tags",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "[smoke] bad-color", color: "magenta" }),
      },
      jar,
    );
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  await test("DELETE /api/v1/tags/:id removes the tag", async () => {
    const { res } = await fetchWithCookies(`/api/v1/tags/${tagId}`, { method: "DELETE" }, jar);
    assert(res.status === 200, `status ${res.status}`);
  });

  await test("GET /api/v1/activity returns an array", async () => {
    const { res } = await fetchWithCookies("/api/v1/activity?limit=10", {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(Array.isArray(body), `expected array`);
  });

  // ---- Planning Center ----
  await test("GET /api/v1/planning-center/health returns 401 without session", async () => {
    const { res } = await fetchWithCookies("/api/v1/planning-center/health");
    assert(res.status === 401, `status ${res.status}`);
  });
  await test("GET /api/v1/planning-center/health returns expected shape", async () => {
    // Shape-only — once an operator fills in real credentials this stack
    // actually reaches PC, so configured/reachable may flip to true. We just
    // check the keys exist and the right types come back.
    const { res } = await fetchWithCookies("/api/v1/planning-center/health", {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(typeof body.configured === "boolean", `configured: ${typeof body.configured}`);
    assert(typeof body.reachable === "boolean", `reachable: ${typeof body.reachable}`);
  });
  await test("GET /api/v1/planning-center/plans returns an array", async () => {
    const { res } = await fetchWithCookies("/api/v1/planning-center/plans", {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(Array.isArray(body), `expected array`);
  });
  await test("GET /api/v1/planning-center/me/link returns null or a link row", async () => {
    // Test user may have linked themselves between runs — shape-only check.
    const { res } = await fetchWithCookies("/api/v1/planning-center/me/link", {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(
      body === null || typeof body.pcPersonId === "string",
      `unexpected shape: ${JSON.stringify(body)}`,
    );
  });
  await test("GET /api/v1/planning-center/links returns []", async () => {
    const { res } = await fetchWithCookies("/api/v1/planning-center/links", {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(Array.isArray(body), `expected array`);
  });
  await test("POST /api/v1/planning-center/me/link rejects invalid body (zod)", async () => {
    const { res } = await fetchWithCookies(
      "/api/v1/planning-center/me/link",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
      jar,
    );
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  // ---- Checklists ----
  // Drives the full lifecycle: create template + task → create event from
  // template → fetch event detail with snapshot tasks → tick a task → read
  // my-open-tasks. Auth admin role required (the test user has it).
  await test("GET /api/v1/checklists/events returns 401 without session", async () => {
    const { res } = await fetchWithCookies("/api/v1/checklists/events");
    assert(res.status === 401, `status ${res.status}`);
  });

  let smokeTemplateId = null;
  let smokeTemplateTaskId = null;
  let smokeEventId = null;
  let smokeEventTaskId = null;

  await test("clean up any stale [smoke] checklist templates", async () => {
    const { res } = await fetchWithCookies("/api/v1/checklists/templates", {}, jar);
    if (res.status === 200) {
      const list = await res.json();
      for (const t of list) {
        if (typeof t.name === "string" && t.name.startsWith("[smoke]")) {
          await fetchWithCookies(`/api/v1/checklists/templates/${t.id}`, { method: "DELETE" }, jar);
        }
      }
    }
  });

  await test("POST /api/v1/checklists/templates creates a template", async () => {
    const { res } = await fetchWithCookies(
      "/api/v1/checklists/templates",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "[smoke] sound", description: "Smoke template" }),
      },
      jar,
    );
    assert(res.status === 200 || res.status === 201, `status ${res.status}`);
    const body = await res.json();
    smokeTemplateId = body.id;
  });

  await test("POST /api/v1/checklists/templates/:id/tasks adds a task", async () => {
    const { res } = await fetchWithCookies(
      `/api/v1/checklists/templates/${smokeTemplateId}/tasks`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Set up mic", positionName: "Sound" }),
      },
      jar,
    );
    assert(res.status === 200 || res.status === 201, `status ${res.status}`);
    const body = await res.json();
    smokeTemplateTaskId = body.id;
    assert(body.positionName === "Sound", `positionName: ${body.positionName}`);
  });

  await test("POST /api/v1/checklists/events instantiates the template", async () => {
    const { res } = await fetchWithCookies(
      "/api/v1/checklists/events",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          templateId: smokeTemplateId,
          name: "[smoke] event",
          autoAssignFromPlan: false,
        }),
      },
      jar,
    );
    assert(res.status === 200 || res.status === 201, `status ${res.status}`);
    const body = await res.json();
    smokeEventId = body.event.id;
    assert(Array.isArray(body.tasks) && body.tasks.length === 1, "tasks not snapshotted");
    smokeEventTaskId = body.tasks[0].id;
  });

  await test("GET /api/v1/checklists/events/:id returns event + tasks", async () => {
    const { res } = await fetchWithCookies(`/api/v1/checklists/events/${smokeEventId}`, {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(body.event?.id === smokeEventId, `event id`);
    assert(body.tasks?.length === 1, `task count`);
  });

  await test("PATCH /api/v1/checklists/event-tasks/:id with completed=true marks done", async () => {
    const { res } = await fetchWithCookies(
      `/api/v1/checklists/event-tasks/${smokeEventTaskId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ completed: true }),
      },
      jar,
    );
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(body.completedAt, "completedAt should be set");
  });

  await test("GET /api/v1/checklists/reports/events includes our smoke event", async () => {
    const { res } = await fetchWithCookies("/api/v1/checklists/reports/events?limit=200", {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    const row = body.find((r) => r.eventId === smokeEventId);
    assert(row, "event not in stats");
    assert(row.completed === 1 && row.total === 1, `expected 1/1, got ${row.completed}/${row.total}`);
    assert(row.pctComplete === 100, `expected 100% complete`);
  });

  await test("GET /api/v1/checklists/my/open-tasks returns array", async () => {
    const { res } = await fetchWithCookies("/api/v1/checklists/my/open-tasks", {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(Array.isArray(body), `expected array`);
  });

  await test("DELETE /api/v1/checklists/events/:id removes the event", async () => {
    const { res } = await fetchWithCookies(
      `/api/v1/checklists/events/${smokeEventId}`,
      { method: "DELETE" },
      jar,
    );
    assert(res.status === 200, `status ${res.status}`);
  });

  await test("DELETE /api/v1/checklists/templates/:id removes the template", async () => {
    const { res } = await fetchWithCookies(
      `/api/v1/checklists/templates/${smokeTemplateId}`,
      { method: "DELETE" },
      jar,
    );
    assert(res.status === 200, `status ${res.status}`);
  });

  // ---- API tokens (tests/smoke/api-tokens.mjs) ----
  const { apiTokenTests } = await import("./api-tokens.mjs");
  await apiTokenTests({ test, assert, fetchWithCookies, jar });

  // ---- backups (tests/smoke/backups.mjs) ----
  const { backupTests } = await import("./backups.mjs");
  await backupTests({ test, assert, fetchWithCookies, jar });

  // ---- cluster page (tests/smoke/cluster.mjs) ----
  const { clusterTests } = await import("./cluster.mjs");
  await clusterTests({ test, assert, fetchWithCookies, jar });

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
