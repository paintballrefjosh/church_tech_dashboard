#!/usr/bin/env node
/**
 * The node watch (apps/api/src/cluster-admin): when an app node stops checking in, the administrators are
 * notified and the Cluster page lists it as a problem; when it returns they are told again and the problem
 * clears. Driven by tests/cluster/shape-d.sh, which kills and restarts the node between the two phases.
 *
 *   NODE=http://host:8201 TARGET=sim-2 PHASE=down|up node tests/cluster/node-watch.mjs
 */
const BASE = process.env.NODE;
const TARGET = process.env.TARGET;
const PHASE = process.env.PHASE;
const EMAIL = "regression-test@local";
const PASSWORD = "regression-smoke-pwd-1";
if (!BASE || !TARGET || !["down", "up"].includes(PHASE ?? "")) {
  console.error("set NODE, TARGET and PHASE=down|up");
  process.exit(2);
}
const jar = new Map();
async function call(path, init = {}) {
  const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await fetch(BASE + path, { ...init, redirect: "manual", headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}) } });
  for (const sc of res.headers.getSetCookie?.() ?? []) {
    const kv = sc.split(";")[0];
    const i = kv.indexOf("=");
    const v = kv.slice(i + 1);
    if (v) jar.set(kv.slice(0, i), v);
  }
  return res;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function login(password) {
  const { csrfToken } = await (await call("/api/auth/csrf")).json();
  await call("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrfToken, email: EMAIL, password, callbackUrl: BASE + "/", json: "true" }),
  });
  return [...jar.keys()].some((k) => k.includes("session-token"));
}
// The usual test password, or (a freshly reset test user) the default one, changed on the spot.
if (!(await login(PASSWORD))) {
  jar.clear();
  if (!(await login("regression-default-pwd"))) { console.error("could not sign in"); process.exit(2); }
  await call("/api/v1/me/change-password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ newPassword: PASSWORD }) });
}

const notices = async () => (await (await call("/api/v1/notifications?limit=100")).json()).filter((n) => n.kind === "cluster.node_down" && n.title.includes(TARGET));
const problems = async () => (await (await call("/api/v1/admin/cluster")).json()).problems.filter((p) => p.message.includes(TARGET));
const wait = async (what, fn, seconds) => {
  const end = Date.now() + seconds * 1000;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${seconds}s waiting for ${what}`);
    await sleep(3000);
  }
};

let ok = true;
const check = (name, pass, extra = "") => { console.log(`  ${pass ? "ok  " : "FAIL"}  ${name}${extra ? ` (${extra})` : ""}`); if (!pass) ok = false; };

try {
  if (PHASE === "down") {
    const t0 = Date.now();
    const note = await wait(`a "stopped" notification for ${TARGET}`, async () => (await notices()).find((n) => /stopped/.test(n.title)), 170);
    check(`the administrators are told that ${TARGET} stopped`, !!note, `${Math.round((Date.now() - t0) / 1000)} s after the kill, ${note.title}`);
    const p = await wait("the problem on the Cluster page", async () => (await problems())[0], 30);
    check("the Cluster page lists it as an error", p.severity === "error" && /stopped checking in/.test(p.message), p.message);
    const stoppedNotes = (await notices()).filter((n) => /stopped/.test(n.title));
    check("it was announced once, not on every check", stoppedNotes.length === 1, `${stoppedNotes.length} notification(s)`);
  } else {
    const t0 = Date.now();
    const back = await wait(`an "is back" notification for ${TARGET}`, async () => (await notices()).find((n) => /is back/.test(n.title)), 120);
    check(`the administrators are told that ${TARGET} is back`, !!back, `${Math.round((Date.now() - t0) / 1000)} s after the restart`);
    const gone = await wait("the problem to clear", async () => (await problems()).length === 0, 60);
    check("the problem is gone from the Cluster page", gone);
  }
} catch (e) {
  check(String(e.message ?? e), false);
}
process.exit(ok ? 0 : 1);
