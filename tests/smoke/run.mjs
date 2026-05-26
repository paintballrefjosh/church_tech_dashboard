#!/usr/bin/env node
/**
 * Phase 0 HTTP smoke tests. Exercises every public-facing endpoint via the
 * Caddy reverse proxy on :8100. Expects:
 *   - `make up` has completed and all services report healthy
 *   - `make migrate && make seed` has run, with bootstrap admin credentials at
 *     /tmp/bootstrap-credentials.txt inside the api container, OR
 *     BOOTSTRAP_ADMIN_EMAIL/BOOTSTRAP_ADMIN_PASSWORD set in the host env
 *
 * Usage: node tests/smoke/run.mjs
 *        BASE=http://localhost:8100 node tests/smoke/run.mjs
 */
import { execFileSync } from "node:child_process";

const BASE = process.env.BASE ?? "http://localhost:8100";
const VERBOSE = process.env.VERBOSE === "1";

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
  // Capture set-cookie headers into the jar. Node fetch exposes raw headers via getSetCookie() since 19.7.
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

function getBootstrapCreds() {
  if (process.env.BOOTSTRAP_ADMIN_EMAIL && process.env.BOOTSTRAP_ADMIN_PASSWORD) {
    return {
      email: process.env.BOOTSTRAP_ADMIN_EMAIL,
      password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
    };
  }
  // Read from inside the api container.
  try {
    const out = execFileSync("docker", [
      "compose",
      "-f",
      "infra/docker-compose.yml",
      "exec",
      "-T",
      "api",
      "cat",
      "/tmp/bootstrap-credentials.txt",
    ], { encoding: "utf8" });
    const emailMatch = out.match(/email:\s+(\S+)/);
    const passMatch = out.match(/password:\s+(\S+)/);
    if (!emailMatch || !passMatch) throw new Error("cannot parse credentials file");
    return { email: emailMatch[1], password: passMatch[1] };
  } catch (err) {
    throw new Error(
      `Could not load bootstrap credentials. Either run \`make seed\` or set BOOTSTRAP_ADMIN_EMAIL/BOOTSTRAP_ADMIN_PASSWORD. (${err.message})`
    );
  }
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

  // ---- authenticated flow ----
  const creds = getBootstrapCreds();
  log(`  using bootstrap admin: ${creds.email}`);
  const jar = new Map();

  // Auth.js v5 Credentials sign-in: GET csrf, then POST callback with csrfToken.
  let csrfToken;
  await test("GET /api/auth/csrf returns csrfToken", async () => {
    const { res, jar: j } = await fetchWithCookies("/api/auth/csrf", {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    csrfToken = body.csrfToken;
    assert(typeof csrfToken === "string" && csrfToken.length > 0, "no csrfToken");
    // jar already mutated in place
  });

  await test("POST /api/auth/callback/credentials with bootstrap creds sets session cookie", async () => {
    const form = new URLSearchParams({
      csrfToken,
      email: creds.email,
      password: creds.password,
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
    // Auth.js typically responds 302 redirecting back to callbackUrl or to /signin?error=... on failure.
    assert(res.status === 200 || res.status === 302, `status ${res.status}`);
    // Verify we have an authjs.session-token in the jar.
    const hasSession = [...j.keys()].some((k) => k.includes("session-token"));
    assert(hasSession, `expected session cookie, got: ${[...j.keys()].join(", ")}`);
  });

  await test("GET /api/v1/me returns user profile with session", async () => {
    const { res } = await fetchWithCookies("/api/v1/me", {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(body.email === creds.email, `email mismatch: ${body.email}`);
    assert(Array.isArray(body.roles) && body.roles.includes("admin"), `roles: ${JSON.stringify(body.roles)}`);
    assert(
      Array.isArray(body.permissions) && body.permissions.includes("users:read:any"),
      `permissions: ${JSON.stringify(body.permissions)}`
    );
  });

  await test("GET /api/v1/users returns at least the bootstrap admin", async () => {
    const { res } = await fetchWithCookies("/api/v1/users", {}, jar);
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(Array.isArray(body) && body.length >= 1, `users count: ${body?.length}`);
    assert(body.some((u) => u.email === creds.email), "bootstrap admin not in list");
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
    // small delay: audit write is fire-and-forget
    await new Promise((r) => setTimeout(r, 250));
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
