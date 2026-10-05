#!/usr/bin/env node
/**
 * Backups and restores across the nodes of a running multi-node stack (tests/cluster/sim.sh up).
 * Destructive by design: it restores over the data, so only ever run it against a throwaway cluster
 * (the cluster tests all are). It needs the regression test user (as cross-node.mjs does).
 *
 *   NODES=http://host:8201,http://host:8202,http://host:8203 node tests/cluster/backup-restore.mjs
 *
 * What it proves, with the work spread over different nodes on purpose:
 *   - a backup made on node A is compared and restored on node B, and the restored data is what
 *     node A and node C then serve (notes, tickets, an uploaded file, search);
 *   - while the restore runs, writes through node C are refused (503) and reads still work;
 *   - a file uploaded since the backup is removed, one deleted since is put back, byte for byte;
 *   - the safety copy taken before the restore undoes it;
 *   - a backup downloaded from A and uploaded through B is checked and usable on C;
 *   - a scheduled backup is made by whichever node leads the scheduler (unless SCHEDULER=0).
 */
import { createHash, randomBytes } from "node:crypto";

const NODES = (process.env.NODES ?? "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
if (NODES.length < 2) {
  console.error("set NODES=<url>,<url>[,<url>...]");
  process.exit(2);
}
const [A, B, C = B] = NODES;
const EMAIL = "regression-test@local";
const PASSWORD = process.env.TEST_PASSWORD ?? "regression-smoke-pwd-1";
const SCHEDULER = process.env.SCHEDULER !== "0";
let pass = 0;
let fail = 0;
const assert = (c, m) => { if (!c) throw new Error(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => createHash("sha256").update(b).digest("hex");
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
const J = { "content-type": "application/json" };
async function login(base, password) {
  const jar = new Map();
  const { csrfToken } = await (await req(base, "/api/auth/csrf", jar)).json();
  await req(base, "/api/auth/callback/credentials", jar, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrfToken, email: EMAIL, password, callbackUrl: base + "/", json: "true" }).toString(),
  });
  return [...jar.keys()].some((k) => k.includes("session-token")) ? jar : null;
}
/** Signs in with the usual test password; a freshly reset test user still has the default one and must change it first. */
async function signIn(base) {
  const ready = await login(base, PASSWORD);
  if (ready) return ready;
  const fresh = await login(base, "regression-default-pwd");
  assert(fresh, `could not sign in to ${base} (run scripts/reset-test-user in that stack first)`);
  const changed = await req(base, "/api/v1/me/change-password", fresh, { method: "POST", headers: J, body: JSON.stringify({ newPassword: PASSWORD }) });
  assert(changed.status === 200 || changed.status === 201, `password change gave ${changed.status}`);
  return fresh;
}
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (n) => Buffer.concat([PNG, randomBytes(n)]);

const jars = {};
const apiAt = async (base, path, init = {}) => req(base, `/api/v1${path}`, jars[base], init);
const jsonAt = async (base, path, init) => {
  const r = await apiAt(base, path, init);
  const text = await r.text();
  if (r.status >= 400) throw new Error(`${init?.method ?? "GET"} ${path} on ${base} gave ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
};

async function waitOp(base, id, seconds = 240) {
  const end = Date.now() + seconds * 1000;
  for (;;) {
    const op = await jsonAt(base, `/admin/backups/operations/${id}`);
    if (op.status !== "running") return op;
    assert(Date.now() < end, `operation ${id} still running after ${seconds}s (${op.phase})`);
    await sleep(1000);
  }
}

async function makeNote(base, title, body = "") {
  return jsonAt(base, "/notes", { method: "POST", headers: J, body: JSON.stringify({ title, body }) });
}
async function attach(base, noteId, bytes, name) {
  const fd = new FormData();
  fd.append("file", new Blob([bytes], { type: "image/png" }), name);
  return jsonAt(base, `/notes/${noteId}/attachments`, { method: "POST", body: fd });
}
async function noteTitles(base) {
  const list = await jsonAt(base, "/notes");
  return new Map(list.map((n) => [n.id, n.title]));
}
async function download(base, noteId, attId) {
  const r = await apiAt(base, `/notes/${noteId}/attachments/${attId}`);
  return { status: r.status, bytes: r.status === 200 ? Buffer.from(await r.arrayBuffer()) : null };
}

const state = {};

await test("sign in on every node", async () => {
  for (const n of new Set(NODES)) jars[n] = await signIn(n);
});

await test("seed: two notes (one with an uploaded file) and a ticket, made through node A", async () => {
  state.n1 = await makeNote(A, "bk note one", "alpha");
  state.n2 = await makeNote(A, "bk note two", "beta");
  state.bytes1 = png(120_000);
  state.a1 = await attach(A, state.n1.id, state.bytes1, "one.png");
  state.t1 = await jsonAt(A, "/tickets", { method: "POST", headers: J, body: JSON.stringify({ title: "bk ticket one", description: "before", priority: "normal" }) });
});

await test("a backup made on node A finishes and lists the right contents (seen from node C)", async () => {
  const started = await jsonAt(A, "/admin/backups", { method: "POST", headers: J, body: JSON.stringify({ name: "bk-e2e original", includeFiles: true }) });
  const op = await waitOp(A, started.operationId);
  assert(op.status === "succeeded", `backup ${op.status}: ${op.error}`);
  state.backupId = op.backupId;
  const b = await jsonAt(C, `/admin/backups/${state.backupId}`);
  assert(b.status === "ready" && b.fileCount >= 1 && b.tableCounts.notes >= 2 && b.tableCounts.tickets >= 1, `backup: ${JSON.stringify({ ...b, tableCounts: undefined })}`);
});

await test("change things since the backup: edit, delete, add (through node A)", async () => {
  await jsonAt(A, `/notes/${state.n1.id}`, { method: "PATCH", headers: J, body: JSON.stringify({ title: "bk note one EDITED" }) });
  await apiAt(A, `/notes/${state.n1.id}/attachments/${state.a1.id}`, { method: "DELETE" }); // the file goes from storage
  await apiAt(A, `/notes/${state.n2.id}`, { method: "DELETE" });
  state.n3 = await makeNote(A, "bk note three (after)", "gamma");
  state.bytes3 = png(60_000);
  state.a3 = await attach(A, state.n3.id, state.bytes3, "three.png");
  state.t2 = await jsonAt(A, "/tickets", { method: "POST", headers: J, body: JSON.stringify({ title: "bk ticket two (after)", description: "after", priority: "low" }) });
  const titles = await noteTitles(B);
  assert(titles.get(state.n1.id) === "bk note one EDITED" && !titles.has(state.n2.id) && titles.has(state.n3.id), "the changes are not visible on node B");
});

await test("compare, asked of node B, describes exactly those changes", async () => {
  const started = await jsonAt(B, `/admin/backups/${state.backupId}/compare`, { method: "POST" });
  const op = await waitOp(B, started.operationId);
  assert(op.status === "succeeded", `compare ${op.status}: ${op.error}`);
  const r = op.result;
  assert(r.compatibility.ok, `not compatible: ${JSON.stringify(r.compatibility)}`);
  const table = (n) => r.groups.flatMap((g) => g.tables).find((t) => t.table === n);
  const notes = table("notes");
  assert(notes && notes.added === 1 && notes.removed === 1 && notes.changed === 1, `notes: ${JSON.stringify(notes && { a: notes.added, r: notes.removed, c: notes.changed })}`);
  assert(notes.samples.added[0].label.includes("bk note two"), `added label: ${notes.samples.added[0]?.label}`);
  assert(notes.samples.removed[0].label.includes("bk note three"), `removed label: ${notes.samples.removed[0]?.label}`);
  const change = notes.samples.changed[0].changes.find((c) => c.column === "title");
  assert(change && change.current === "bk note one EDITED" && change.backup === "bk note one", `change: ${JSON.stringify(change)}`);
  assert(table("tickets")?.removed === 1, "the ticket made since should be listed as deleted");
  const attachments = table("attachments");
  assert(attachments && attachments.added === 1 && attachments.removed === 1, "attachments");
  // "removed" also counts any stray file already in storage (one no database row refers to), so at least one.
  assert(r.files.added === 1 && r.files.removed >= 1, `files: ${JSON.stringify(r.files)}`);
  assert(r.you && r.you.status === "unchanged", `you: ${JSON.stringify(r.you)}`);
  assert(r.secretMismatch === false, "secret mismatch");
});

await test("restore on node B: writes through node C are refused while it runs, reads are not, and it succeeds", async () => {
  const writes = [];
  const reads = [];
  const created = [];
  let probing = true;
  const prober = (async () => {
    while (probing) {
      try {
        const w = await apiAt(C, "/notes", { method: "POST", headers: J, body: JSON.stringify({ title: "probe note", body: "" }) });
        writes.push(w.status);
        if (w.status === 200 || w.status === 201) created.push((await w.json()).id);
        else await w.text();
        const r = await apiAt(C, "/me");
        reads.push(r.status);
        await r.text();
      } catch {
        writes.push("error");
      }
      await sleep(250);
    }
  })();
  const started = await jsonAt(B, `/admin/backups/${state.backupId}/restore`, { method: "POST", headers: J, body: JSON.stringify({ confirm: "RESTORE", safetyBackup: true }) });
  const op = await waitOp(B, started.operationId);
  probing = false;
  await prober;
  assert(op.status === "succeeded", `restore ${op.status}: ${op.error}`);
  const res = op.result;
  state.safetyId = res.safetyBackupId;
  assert(res.safetyBackupId, "no safety backup was made");
  assert(res.rowsAdded >= 2 && res.rowsRemoved >= 2 && res.rowsChanged >= 1, `result: ${JSON.stringify(res)}`);
  assert(res.filesRestored === 1 && res.filesRemoved >= 1, `files: ${JSON.stringify(res)}`);
  assert(res.warnings.length === 0, `warnings: ${res.warnings.join("; ")}`);
  assert(writes.includes(503), `no write was refused while the restore ran (statuses: ${[...new Set(writes)].join(",")})`);
  assert(reads.length > 0 && reads.every((s) => s === 200), `a read failed during the restore: ${[...new Set(reads)].join(",")}`);
  // Writes work again afterwards.
  const after = await apiAt(C, "/notes", { method: "POST", headers: J, body: JSON.stringify({ title: "probe after", body: "" }) });
  assert(after.status === 200 || after.status === 201, `write after the restore gave ${after.status}`);
  created.push((await after.json()).id);
  state.probeIds = created;
});

await test("the data is as it was, as served by nodes A and C", async () => {
  for (const base of new Set([A, C])) {
    const titles = await noteTitles(base);
    assert(titles.get(state.n1.id) === "bk note one", `${base}: note one is "${titles.get(state.n1.id)}"`);
    assert(titles.get(state.n2.id) === "bk note two", `${base}: note two missing`);
    assert(!titles.has(state.n3.id), `${base}: the note made after the backup is still there`);
    const tickets = await jsonAt(base, "/tickets");
    assert(tickets.some((t) => t.id === state.t1.id), `${base}: ticket one missing`);
    assert(!tickets.some((t) => t.id === state.t2.id), `${base}: the ticket made after the backup is still there`);
  }
});

await test("the uploaded file deleted since is back byte for byte, and the one added since is gone", async () => {
  const back = await download(C, state.n1.id, state.a1.id);
  assert(back.status === 200 && sha(back.bytes) === sha(state.bytes1), `restored file: status ${back.status}`);
  const gone = await download(C, state.n3.id, state.a3.id);
  assert(gone.status === 404, `the file added since the backup answered ${gone.status}`);
});

await test("search on node C has the restored data (and not the undone)", async () => {
  const deadline = Date.now() + 60_000;
  let ok = false;
  let last = "";
  while (Date.now() < deadline && !ok) {
    const two = await jsonAt(C, `/search?q=${encodeURIComponent("bk note two")}`);
    const three = await jsonAt(C, `/search?q=${encodeURIComponent("bk note three")}`);
    const has = (res, text) => (res.hits ?? []).some((h) => JSON.stringify(h).includes(text));
    ok = has(two, "bk note two") && !has(three, "bk note three");
    last = `two found: ${has(two, "bk note two")}, three found: ${has(three, "bk note three")}`;
    if (!ok) await sleep(2000);
  }
  assert(ok, `search did not converge on the restored data (${last})`);
});

await test("the safety copy is listed and undoes the restore", async () => {
  const b = await jsonAt(A, `/admin/backups/${state.safetyId}`);
  assert(b.kind === "pre_restore" && b.status === "ready", `safety: ${JSON.stringify({ k: b.kind, s: b.status })}`);
  const started = await jsonAt(A, `/admin/backups/${state.safetyId}/restore`, { method: "POST", headers: J, body: JSON.stringify({ confirm: "RESTORE", safetyBackup: false }) });
  const op = await waitOp(A, started.operationId);
  assert(op.status === "succeeded", `undo ${op.status}: ${op.error}`);
  const titles = await noteTitles(B);
  assert(titles.get(state.n1.id) === "bk note one EDITED", "note one is not back to the edited state");
  assert(!titles.has(state.n2.id) && titles.has(state.n3.id), "notes two/three are not as they were before the first restore");
  const f3 = await download(B, state.n3.id, state.a3.id);
  assert(f3.status === 200 && sha(f3.bytes) === sha(state.bytes3), "the file added after the backup is not back");
  const f1 = await download(B, state.n1.id, state.a1.id);
  assert(f1.status === 404, "the file deleted since should be gone again");
});

await test("a backup downloaded from node A and uploaded through node B is checked and usable on node C", async () => {
  const link = await jsonAt(A, `/admin/backups/${state.backupId}/download-link`, { method: "POST" });
  const dl = await apiAt(A, link.url.replace("/api/v1", ""));
  assert(dl.status === 200, `download status ${dl.status}`);
  const bytes = Buffer.from(await dl.arrayBuffer());
  assert(bytes[0] === 0x1f && bytes[1] === 0x8b, "not gzip");
  const fd = new FormData();
  fd.append("file", new Blob([bytes], { type: "application/gzip" }), "carried-over.tar.gz");
  const up = await jsonAt(B, "/admin/backups/upload", { method: "POST", body: fd });
  const op = await waitOp(B, up.operationId);
  assert(op.status === "succeeded", `import ${op.status}: ${op.error}`);
  state.uploadedId = up.backupId;
  const b = await jsonAt(C, `/admin/backups/${up.backupId}`);
  assert(b.kind === "uploaded" && b.status === "ready" && b.fileCount === 1, `uploaded: ${JSON.stringify({ k: b.kind, s: b.status, f: b.fileCount })}`);
  const cmp = await jsonAt(C, `/admin/backups/${up.backupId}/compare`, { method: "POST" });
  const cop = await waitOp(C, cmp.operationId);
  assert(cop.status === "succeeded" && cop.result.compatibility.ok, `compare of the upload: ${cop.status} ${cop.error}`);
});

if (SCHEDULER) {
  await test("a scheduled backup is made by the node that leads the scheduler (within about two minutes)", async () => {
    const now = new Date(Date.now() + 70_000);
    const time = `${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}`;
    const s = await jsonAt(B, "/admin/backups/schedules", { method: "POST", headers: J, body: JSON.stringify({ name: "bk-e2e schedule", frequency: "daily", time, timezone: "UTC", keep: 1, includeFiles: false }) });
    state.scheduleId = s.id;
    const end = Date.now() + 200_000;
    let made = null;
    while (Date.now() < end && !made) {
      const list = await jsonAt(C, "/admin/backups");
      made = list.find((b) => b.scheduleId === s.id && b.status === "ready");
      if (!made) await sleep(3000);
    }
    assert(made, "no scheduled backup appeared");
    assert(made.kind === "scheduled", `kind ${made.kind}`);
    const after = (await jsonAt(A, "/admin/backups/schedules")).find((x) => x.id === s.id);
    assert(after.lastStatus === "ok" && after.lastRunAt, `schedule: ${JSON.stringify(after)}`);
    assert(new Date(after.nextRunAt).getTime() > Date.now() + 3600_000, `next run not moved on: ${after.nextRunAt}`);
  });
}

await test("cleanup: delete what this test made", async () => {
  for (const id of state.probeIds ?? []) await apiAt(A, `/notes/${id}`, { method: "DELETE" }).then((r) => r.text());
  for (const id of [state.n1?.id, state.n2?.id, state.n3?.id]) if (id) await apiAt(A, `/notes/${id}`, { method: "DELETE" }).then((r) => r.text());
  if (state.scheduleId) await apiAt(A, `/admin/backups/schedules/${state.scheduleId}`, { method: "DELETE" }).then((r) => r.text());
  const list = await jsonAt(A, "/admin/backups");
  for (const b of list) {
    if (/^bk-e2e|^Before restoring "bk-e2e|^carried-over|bk-e2e schedule/.test(b.name)) await apiAt(A, `/admin/backups/${b.id}`, { method: "DELETE" }).then((r) => r.text());
  }
});

console.log(`\nbackup-restore: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
