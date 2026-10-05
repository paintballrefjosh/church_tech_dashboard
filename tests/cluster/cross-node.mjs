#!/usr/bin/env node
/**
 * Cross-node checks for a running multi-node stack (docs/multi-node.md): what a user sees must not
 * depend on which node served them. Run it after the smoke suite has run against one node (it
 * reuses the regression test user, whose password the smoke suite leaves at the value below), or
 * set TEST_PASSWORD.
 *
 *   NODES=http://host:8201,http://host:8202,http://host:8203 node tests/cluster/cross-node.mjs
 *
 * Checks: a session from one node is accepted by every other; a note written through one node is
 * read through the others; an upload written through one node (several MB, so it spans object
 * store blocks) downloads byte-for-byte through the others; each node's own search index finds a
 * note made on another.
 *
 * For failure tests (tests/cluster/failover.sh): MODE=seed STATE_FILE=f stores a note with an
 * upload and keeps it; MODE=verify STATE_FILE=f NODES=<the nodes still up> checks that the stored
 * upload still downloads identically through each of them, and that each of them still accepts
 * new notes and uploads.
 */
import { createHash, randomBytes } from "node:crypto";

const NODES = (process.env.NODES ?? "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
// verify mode may check a single surviving node; every other mode compares two or more.
if (NODES.length < ((process.env.MODE ?? "full") === "verify" ? 1 : 2)) {
  console.error("set NODES=<url>,<url>[,<url>...]");
  process.exit(2);
}
const EMAIL = "regression-test@local";
const PASSWORD = process.env.TEST_PASSWORD ?? "regression-smoke-pwd-1";
let pass = 0;
let fail = 0;
const assert = (c, m) => { if (!c) throw new Error(m); };
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ok    ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n        ${e?.message ?? e}`); }
}

async function req(base, path, jar, init = {}) {
  const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await fetch(base + path, { ...init, redirect: "manual", headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}) } });
  for (const sc of res.headers.getSetCookie?.() ?? []) {
    const kv = sc.split(";")[0];
    const eq = kv.indexOf("=");
    if (eq > 0) { const v = kv.slice(eq + 1).trim(); if (v) jar.set(kv.slice(0, eq).trim(), v); else jar.delete(kv.slice(0, eq).trim()); }
  }
  return res;
}
const json = (r) => r.json();
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

async function login(base, password) {
  const jar = new Map();
  const { csrfToken } = await json(await req(base, "/api/auth/csrf", jar));
  const res = await req(base, "/api/auth/callback/credentials", jar, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrfToken, email: EMAIL, password, callbackUrl: base + "/", json: "true" }).toString(),
  });
  if (res.status !== 200 && res.status !== 302) return null;
  return [...jar.keys()].some((k) => k.includes("session-token")) ? jar : null;
}

/** Signs in with the usual test password; a freshly reset test user still has the default one and must change it first. */
async function signIn(base) {
  const ready = await login(base, PASSWORD);
  if (ready) return ready;
  const fresh = await login(base, "regression-default-pwd");
  assert(fresh, `could not sign in to ${base} (run reset-test-user in that stack first)`);
  const changed = await req(base, "/api/v1/me/change-password", fresh, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ newPassword: PASSWORD }) });
  assert(changed.status === 200 || changed.status === 201, `password change gave ${changed.status}`);
  return fresh;
}

const MODE = process.env.MODE ?? "full";
const STATE_FILE = process.env.STATE_FILE;
const token = randomBytes(5).toString("hex");
const A = NODES[0];
const others = NODES.slice(1);
let jar;
let noteId;

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
async function upload(base, jar, note, bytes) {
  const fd = new FormData();
  fd.append("file", new Blob([bytes], { type: "image/png" }), "big.png");
  const r = await req(base, `/api/v1/notes/${note}/attachments`, jar, { method: "POST", body: fd });
  if (r.status !== 200 && r.status !== 201) throw new Error(`upload through ${base} gave ${r.status}: ${await r.text()}`);
  return (await json(r)).id;
}
async function download(base, jar, note, att) {
  const g = await req(base, `/api/v1/notes/${note}/attachments/${att}`, jar);
  if (g.status !== 200) throw new Error(`${base}: download gave ${g.status}`);
  return Buffer.from(await g.arrayBuffer());
}

if (MODE === "verify") {
  const { readFileSync } = await import("node:fs");
  const st = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  const jars = new Map();
  for (const n of NODES) await test(`sign in through ${n}`, async () => { jars.set(n, await signIn(n)); });
  for (const n of NODES) {
    await test(`${n}: the stored upload downloads identically`, async () => {
      const got = await download(n, jars.get(n), st.noteId, st.attId);
      assert(got.length === st.size && sha(got) === st.sha, `bytes differ (${got.length} vs ${st.size})`);
    });
    await test(`${n}: accepts a new note and a 3 MB upload, which another node can read`, async () => {
      const j = jars.get(n);
      const r = await req(n, "/api/v1/notes", j, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: `verify ${token}`, body: "" }) });
      assert(r.status === 200 || r.status === 201, `create gave ${r.status}`);
      const id = (await json(r)).id;
      const bytes = Buffer.concat([PNG_SIG, randomBytes(3 * 1024 * 1024)]);
      const att = await upload(n, j, id, bytes);
      const other = NODES.find((x) => x !== n) ?? n;
      const got = await download(other, jars.get(other), id, att);
      assert(sha(got) === sha(bytes), "bytes differ through the other node");
      await req(n, `/api/v1/notes/${id}`, j, { method: "DELETE" });
    });
  }
  console.log(`\ncross-node verify: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

await test(`sign in through ${A}`, async () => { jar = await signIn(A); });
await test("the session cookie is accepted by every other node (no stickiness)", async () => {
  for (const n of others) {
    const r = await req(n, "/api/v1/me", jar);
    assert(r.status === 200, `${n}: /me gave ${r.status}`);
    assert((await json(r)).email === EMAIL, `${n}: wrong user`);
  }
});

await test(`a note created through ${A} is read through the others`, async () => {
  const r = await req(A, "/api/v1/notes", jar, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: `xnode ${token}`, body: `zebrafish${token}` }) });
  assert(r.status === 200 || r.status === 201, `create gave ${r.status}`);
  noteId = (await json(r)).id;
  for (const n of others) {
    const g = await req(n, `/api/v1/notes/${noteId}`, jar);
    assert(g.status === 200, `${n}: read gave ${g.status}`);
    assert((await json(g)).title === `xnode ${token}`, `${n}: title differs`);
  }
});

// The API sniffs the type: a PNG signature, then random bytes (incompressible, spans several blocks).
const payload = Buffer.concat([PNG_SIG, randomBytes(6 * 1024 * 1024)]);
let attId;
await test(`a 6 MB upload through ${A} downloads identically through every node`, async () => {
  const fd = new FormData();
  fd.append("file", new Blob([payload], { type: "image/png" }), "big.png");
  const r = await req(A, `/api/v1/notes/${noteId}/attachments`, jar, { method: "POST", body: fd });
  if (r.status !== 200 && r.status !== 201) throw new Error(`upload gave ${r.status}: ${await r.text()}`);
  attId = (await json(r)).id;
  for (const n of NODES) {
    const g = await req(n, `/api/v1/notes/${noteId}/attachments/${attId}`, jar);
    assert(g.status === 200, `${n}: download gave ${g.status}`);
    const got = Buffer.from(await g.arrayBuffer());
    assert(got.length === payload.length && sha(got) === sha(payload), `${n}: bytes differ (${got.length} vs ${payload.length})`);
  }
});

await test("every node's own search index finds the note (within 20 s)", async () => {
  const deadline = Date.now() + 20000;
  const missing = new Set(NODES);
  while (missing.size && Date.now() < deadline) {
    for (const n of [...missing]) {
      const r = await req(n, `/api/v1/search?q=${encodeURIComponent("xnode " + token)}`, jar);
      if (r.status === 200 && (await json(r)).hits?.some((h) => String(h.resourceId ?? h.id ?? "") === noteId || JSON.stringify(h).includes(noteId))) missing.delete(n);
    }
    if (missing.size) await new Promise((r) => setTimeout(r, 1000));
  }
  assert(missing.size === 0, `not found on: ${[...missing].join(", ")}`);
});

if (MODE === "seed") {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(STATE_FILE, JSON.stringify({ noteId, attId, sha: sha(payload), size: payload.length }));
  console.log(`\ncross-node seed: ${pass} passed, ${fail} failed (kept note ${noteId})`);
  process.exit(fail ? 1 : 0);
}

await test("cleanup: delete the note", async () => {
  const r = await req(A, `/api/v1/notes/${noteId}`, jar, { method: "DELETE" });
  assert(r.status === 200 || r.status === 204, `delete gave ${r.status}`);
});

console.log(`\ncross-node: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
