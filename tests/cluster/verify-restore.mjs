#!/usr/bin/env node
/**
 * The HTTP half of tests/cluster/verify-restore.sh. Steps, each its own invocation so the shell can do the
 * docker work between them:
 *
 *   fetch-dev   BASE=<dev stack url> OUT=<file>     make a backup of the LIVE dev stack (reads only), save it, delete it again
 *   restore     BASE=<sim node url> ARCHIVE=<file>  upload it to the throwaway cluster, check it, compare it, start the restore
 *   answers     BASE=<sim node url>                 after the restore: the restored site answers as its own signed-in user
 *
 * The throwaway cluster is destroyed and recreated by tests/cluster/sim.sh; nothing here ever restores onto the dev stack.
 */
import { readFileSync, writeFileSync } from "node:fs";

const BASE = (process.env.BASE ?? "").replace(/\/$/, "");
const EMAIL = "regression-test@local";
const PASSWORD = process.env.TEST_PASSWORD ?? "regression-smoke-pwd-1";
const step = process.argv[2];
if (!BASE || !["fetch-dev", "restore", "answers"].includes(step ?? "")) {
  console.error("usage: BASE=<url> [OUT=|ARCHIVE=] node verify-restore.mjs fetch-dev|restore|answers");
  process.exit(2);
}
const J = { "content-type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };
const jar = new Map();

async function req(path, init = {}) {
  const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await fetch(BASE + path, { ...init, redirect: "manual", headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}) } });
  for (const sc of res.headers.getSetCookie?.() ?? []) {
    const kv = sc.split(";")[0];
    const eq = kv.indexOf("=");
    if (eq > 0) { const v = kv.slice(eq + 1).trim(); if (v) jar.set(kv.slice(0, eq).trim(), v); else jar.delete(kv.slice(0, eq).trim()); }
  }
  return res;
}
async function login(password) {
  jar.clear();
  const { csrfToken } = await (await req("/api/auth/csrf")).json();
  await req("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrfToken, email: EMAIL, password, callbackUrl: BASE + "/", json: "true" }).toString(),
  });
  return [...jar.keys()].some((k) => k.includes("session-token"));
}
/** The usual test password, or the default one (changed on the spot), as the other cluster tests do. */
async function signIn() {
  if (await login(PASSWORD)) return;
  assert(await login("regression-default-pwd"), `could not sign in to ${BASE} as ${EMAIL}`);
  const r = await req("/api/v1/me/change-password", { method: "POST", headers: J, body: JSON.stringify({ newPassword: PASSWORD }) });
  assert(r.status === 200 || r.status === 201, `password change gave ${r.status}`);
  assert(await login(PASSWORD), "could not sign in again after the password change");
}
async function api(path, init) {
  const r = await req(`/api/v1${path}`, init);
  const text = await r.text();
  if (r.status >= 400) throw new Error(`${init?.method ?? "GET"} ${path} gave ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}
async function waitOp(id, seconds = 600) {
  const end = Date.now() + seconds * 1000;
  for (;;) {
    const op = await api(`/admin/backups/operations/${id}`);
    if (op.status !== "running") return op;
    assert(Date.now() < end, `operation ${id} still running after ${seconds}s (${op.phase})`);
    await sleep(1500);
  }
}
const say = (m) => console.log(`  ${m}`);

if (step === "fetch-dev") {
  await signIn();
  const started = await api("/admin/backups", { method: "POST", headers: J, body: JSON.stringify({ name: "[rehearsal] copy of the dev stack", includeFiles: true }) });
  const op = await waitOp(started.operationId);
  assert(op.status === "succeeded", `backup ${op.status}: ${op.error}`);
  const b = await api(`/admin/backups/${op.backupId}`);
  say(`backup of the dev stack: ${b.totalRows} rows, ${b.fileCount} files, ${b.sizeBytes} bytes`);
  try {
    const link = await api(`/admin/backups/${op.backupId}/download-link`, { method: "POST" });
    const dl = await req(link.url);
    assert(dl.status === 200, `download gave ${dl.status}`);
    const bytes = Buffer.from(await dl.arrayBuffer());
    assert(bytes.length === b.sizeBytes, `downloaded ${bytes.length} bytes, expected ${b.sizeBytes}`);
    writeFileSync(process.env.OUT ?? "dev.tar.gz", bytes);
  } finally {
    await api(`/admin/backups/${op.backupId}`, { method: "DELETE" }).catch(() => undefined); // leave nothing behind on the dev stack
  }
} else if (step === "restore") {
  await signIn();
  const bytes = readFileSync(process.env.ARCHIVE ?? "");
  const fd = new FormData();
  fd.append("file", new Blob([bytes], { type: "application/gzip" }), "rehearsal.tar.gz");
  const up = await api("/admin/backups/upload", { method: "POST", body: fd });
  const imported = await waitOp(up.operationId);
  assert(imported.status === "succeeded", `the file was refused: ${imported.error}`);
  say("uploaded and accepted (every row count and file checksum checked on the way in)");

  const check = await waitOp((await api(`/admin/backups/${up.backupId}/verify`, { method: "POST" })).operationId);
  assert(check.status === "succeeded" && check.result.failed === 0, `stored-backup check: ${check.status} ${check.error ?? JSON.stringify(check.result)}`);
  const checked = await api(`/admin/backups/${up.backupId}`);
  assert(checked.verifiedAt && !checked.verifyError, "the check did not record a pass on the backup");
  say(`stored-backup check passed: ${check.result.results[0].rows} rows, ${check.result.results[0].files} files`);

  const cmp = await waitOp((await api(`/admin/backups/${up.backupId}/compare`, { method: "POST" })).operationId);
  assert(cmp.status === "succeeded", `compare ${cmp.status}: ${cmp.error}`);
  assert(cmp.result.compatibility.ok, `the backup cannot be restored here: ${cmp.result.compatibility.errors.join("; ")}`);
  say(`compared with the empty-ish cluster: ${cmp.result.totals.added} rows to bring back, ${cmp.result.totals.removed} to remove, ${cmp.result.totals.changed} to change`);

  const started = await api(`/admin/backups/${up.backupId}/restore`, {
    method: "POST",
    headers: J,
    body: JSON.stringify({ confirm: "RESTORE", safetyBackup: true, acceptSecretMismatch: true }),
  });
  // The restore replaces the account that asked for it (the backup came from elsewhere), so this session ends:
  // the shell watches the operation from inside the cluster instead.
  console.log(`OPERATION ${started.operationId}`);
} else {
  await signIn();
  const me = await api("/me");
  assert(me.email === EMAIL, `signed in as ${me.email}`);
  for (const path of ["/notes", "/tickets", "/wiki", "/checklists/templates", "/monitors"]) {
    const r = await req(`/api/v1${path}`);
    assert(r.status === 200, `GET ${path} gave ${r.status}`);
    await r.text();
  }
  const ready = await req("/api/v1/readyz");
  assert(ready.status === 200, `readyz gave ${ready.status}`);
  const list = await api("/admin/backups");
  assert(list.some((b) => b.kind === "pre_restore"), "the safety copy taken before the restore is missing");
  say("signed in as the restored test user; notes, tickets, wiki, checklists and monitors answer; the safety copy exists");
}
