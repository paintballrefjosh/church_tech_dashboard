import { gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";

/**
 * Backup smoke tests (admin > Backups), run from run.mjs. Everything here is non-destructive: it
 * makes, downloads, uploads, compares and deletes backups of the running stack. It never restores,
 * because a restore rewinds the live data the rest of the suite is using; restores are tested on a
 * throwaway cluster (tests/cluster/backup-restore.sh) and by the engine's own integration tests.
 * Every backup, schedule and upload made here is deleted before the block ends.
 */
export async function backupTests({ test, assert, fetchWithCookies, jar }) {
  const json = (body) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const session = (path, init = {}) => fetchWithCookies(path, init, jar);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const made = []; // backup ids to delete at the end
  const schedules = [];

  async function waitFor(operationId, seconds = 180) {
    const deadline = Date.now() + seconds * 1000;
    for (;;) {
      const { res } = await session(`/api/v1/admin/backups/operations/${operationId}`);
      assert(res.status === 200, `operation status ${res.status}`);
      const op = await res.json();
      if (op.status !== "running") return op;
      assert(Date.now() < deadline, `operation ${operationId} still running after ${seconds}s (${op.phase})`);
      await sleep(1000);
    }
  }

  let first; // a backup made through the API

  await test("backups: the list and storage endpoints answer", async () => {
    const list = await session("/api/v1/admin/backups");
    assert(list.res.status === 200, `list status ${list.res.status}`);
    assert(Array.isArray(await list.res.json()), "list is not an array");
    const storage = await session("/api/v1/admin/backups/storage");
    assert(storage.res.status === 200, `storage status ${storage.res.status}`);
    const s = await storage.res.json();
    assert(s.available === true, `store not available: ${JSON.stringify(s)}`);
  });

  await test("backups: POST creates one in the background and it finishes ready", async () => {
    const { res } = await session("/api/v1/admin/backups", { method: "POST", ...json({ name: "[smoke] first", includeFiles: true }) });
    assert(res.status === 202, `create status ${res.status}`);
    const { operationId } = await res.json();
    assert(typeof operationId === "string", "no operationId");
    const op = await waitFor(operationId);
    assert(op.status === "succeeded", `backup operation ${op.status}: ${op.error}`);
    assert(op.backupId && op.kind === "backup", `operation: ${JSON.stringify(op)}`);
    const one = await session(`/api/v1/admin/backups/${op.backupId}`);
    first = await one.res.json();
    made.push(first.id);
    assert(first.status === "ready" && first.kind === "manual", `backup: ${JSON.stringify(first)}`);
    assert(first.sizeBytes > 1000, `size ${first.sizeBytes}`);
    assert(first.tableCounts.users >= 1 && first.tableCounts.groups >= 1 && first.tableCounts.permissions >= 1, `counts ${JSON.stringify(first.tableCounts)}`);
    assert(first.schemaMigrations > 0, `migrations ${first.schemaMigrations}`);
    assert(!("audit_log" in first.tableCounts), "the audit log must not be in a backup");
    assert(first.createdBy && first.createdBy.email, "no creator");
  });

  await test("backups: only one operation at a time (a second one is refused while the first runs)", async () => {
    const a = await session("/api/v1/admin/backups", { method: "POST", ...json({ name: "[smoke] a", includeFiles: false }) });
    assert(a.res.status === 202, `first status ${a.res.status}`);
    const b = await session("/api/v1/admin/backups", { method: "POST", ...json({ name: "[smoke] b", includeFiles: false }) });
    const opA = await a.res.json();
    if (b.res.status === 202) {
      // The first finished before the second arrived: fine, just wait for both.
      const opB = await b.res.json();
      const done = await waitFor(opB.operationId);
      made.push(done.backupId);
    } else {
      assert(b.res.status === 409, `second status ${b.res.status}`);
    }
    const done = await waitFor(opA.operationId);
    assert(done.status === "succeeded", `a: ${done.error}`);
    made.push(done.backupId);
  });

  let bytes;
  await test("backups: download is two steps, a signed link then the file, and it is a gzip of the right size", async () => {
    const { res } = await session(`/api/v1/admin/backups/${first.id}/download-link`, { method: "POST" });
    assert(res.status === 201 || res.status === 200, `link status ${res.status}`);
    const link = await res.json();
    assert(link.url.startsWith("/api/v1/admin/backups/download?token=") && link.filename.endsWith(".tar.gz"), `link ${JSON.stringify(link)}`);
    const dl = await session(link.url);
    assert(dl.res.status === 200, `download status ${dl.res.status}`);
    assert(/attachment/.test(dl.res.headers.get("content-disposition") ?? ""), "not an attachment");
    bytes = Buffer.from(await dl.res.arrayBuffer());
    assert(bytes[0] === 0x1f && bytes[1] === 0x8b, "not gzip");
    assert(bytes.length === first.sizeBytes, `got ${bytes.length} bytes, expected ${first.sizeBytes}`);
    const forged = await session(`${link.url.slice(0, -3)}xxx`);
    assert(forged.res.status === 400, `forged link status ${forged.res.status}`);
    const none = await session("/api/v1/admin/backups/download");
    assert(none.res.status === 400, `missing token status ${none.res.status}`);
  });

  await test("backups: compare reports what a restore would change (a backup just made differs little)", async () => {
    const { res } = await session(`/api/v1/admin/backups/${first.id}/compare`, { method: "POST" });
    assert(res.status === 202, `compare status ${res.status}`);
    const op = await waitFor((await res.json()).operationId);
    assert(op.status === "succeeded", `compare ${op.status}: ${op.error}`);
    const report = op.result;
    assert(report.backupId === first.id && report.compatibility.ok === true, `report: ${JSON.stringify(report.compatibility)}`);
    assert(Array.isArray(report.groups) && Array.isArray(report.identicalTables) && report.totals.unchanged > 0, "report shape");
    assert(report.secretMismatch === false, "secret mismatch on our own backup");
    assert(report.files && typeof report.files.added === "number", "no files section");
    assert(report.you && ["unchanged", "changed", "removed"].includes(report.you.status), "no 'you' section");
    // Nothing about our own account changes in a backup made a moment ago.
    assert(report.you.status === "unchanged", `you: ${JSON.stringify(report.you)}`);
    // Secrets are never shown.
    const text = JSON.stringify(report);
    assert(!/password_hash":"/.test(text) || /"secret":true/.test(text), "a secret column's value is in the report");
  });

  await test("backups: a restore can be limited to sections; the list names them and what is in each", async () => {
    const { res } = await session("/api/v1/admin/backups/restore-sections");
    assert(res.status === 200, `status ${res.status}`);
    const list = await res.json();
    const keys = list.map((x) => x.key);
    for (const k of ["people-and-access", "wiki", "notes", "helpdesk", "monitoring", "files"]) assert(keys.includes(k), `no section ${k}: ${keys}`);
    assert(list.every((x) => x.title && x.description && x.tables.length > 0), "a section lacks a title, description or tables");
    assert(list.filter((x) => x.hasFiles).map((x) => x.key).join() === "files", "only Files holds files");
  });

  await test("backups: comparing only the wiki leaves out everything else, files and your own account included", async () => {
    const { res } = await session(`/api/v1/admin/backups/${first.id}/compare`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sections: ["wiki"] }) });
    assert(res.status === 202, `compare status ${res.status}`);
    const op = await waitFor((await res.json()).operationId);
    assert(op.status === "succeeded", `compare ${op.status}: ${op.error}`);
    const report = op.result;
    assert(report.scope.partial === true && report.scope.sections.join() === "wiki", `scope: ${JSON.stringify(report.scope)}`);
    const tables = report.groups.flatMap((g) => g.tables.map((t) => t.table));
    assert(tables.every((t) => t.startsWith("wiki_")), `tables outside the wiki: ${tables}`);
    assert(report.files === null, "files are not part of a wiki-only restore");
    assert(report.you === null, "your account is not part of a wiki-only restore");
    assert(Array.isArray(report.skipped) && Array.isArray(report.kept), "no skipped/kept lists");
  });

  await test("backups: an unknown or empty section list is refused before anything starts", async () => {
    const post = (path, body) => session(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const unknown = await post(`/api/v1/admin/backups/${first.id}/compare`, { sections: ["nonsense"] });
    assert(unknown.res.status === 400 && /Unknown section/.test(await unknown.res.text()), `unknown: ${unknown.res.status}`);
    const empty = await post(`/api/v1/admin/backups/${first.id}/compare`, { sections: [] });
    assert(empty.res.status === 400, `empty: ${empty.res.status}`);
    // The same for a restore (validation comes before the restore starts; the typed phrase is correct here on purpose).
    const restore = await post(`/api/v1/admin/backups/${first.id}/restore`, { confirm: "RESTORE", sections: ["nonsense"] });
    assert(restore.res.status === 400 && /Unknown section/.test(await restore.res.text()), `restore: ${restore.res.status}`);
  });

  await test("backups: upload takes a downloaded backup back in and checks it", async () => {
    const fd = new FormData();
    fd.append("file", new Blob([bytes], { type: "application/gzip" }), "[smoke] uploaded.tar.gz");
    const { res } = await session("/api/v1/admin/backups/upload", { method: "POST", body: fd });
    assert(res.status === 202, `upload status ${res.status}: ${await res.clone().text()}`);
    const { backupId, operationId } = await res.json();
    made.push(backupId);
    const op = await waitFor(operationId);
    assert(op.status === "succeeded", `import ${op.status}: ${op.error}`);
    const one = await (await session(`/api/v1/admin/backups/${backupId}`)).res.json();
    assert(one.kind === "uploaded" && one.status === "ready", `uploaded: ${JSON.stringify(one)}`);
    assert(one.tableCounts.users === first.tableCounts.users, "row counts differ after the round trip");
  });

  await test("backups: a damaged or foreign upload is rejected, even a big one (over the ordinary 10 MiB upload limit)", async () => {
    const notGzip = new FormData();
    notGzip.append("file", new Blob([Buffer.from("this is not a backup")]), "junk.tar.gz");
    const a = await session("/api/v1/admin/backups/upload", { method: "POST", body: notGzip });
    assert(a.res.status === 400, `junk status ${a.res.status}`);

    // 12 MiB of gzip that is not a backup: accepted as an upload, refused by the check that follows.
    const big = new FormData();
    big.append("file", new Blob([gzipSync(randomBytes(12 * 1024 * 1024))]), "big-junk.tar.gz");
    const b = await session("/api/v1/admin/backups/upload", { method: "POST", body: big });
    assert(b.res.status === 202, `big upload status ${b.res.status}: ${await b.res.clone().text()}`);
    const { backupId, operationId } = await b.res.json();
    made.push(backupId);
    const op = await waitFor(operationId);
    assert(op.status === "failed" && /not a dashboard backup|damaged|checksum|backup/i.test(op.error ?? ""), `op: ${op.status} ${op.error}`);
    const row = await (await session(`/api/v1/admin/backups/${backupId}`)).res.json();
    assert(row.status === "failed" && row.error, "the failed upload has no error");
    // A failed backup cannot be compared or restored.
    const c = await session(`/api/v1/admin/backups/${backupId}/compare`, { method: "POST" });
    assert(c.res.status === 400, `compare of a failed backup: ${c.res.status}`);
  });

  await test("backups: restore refuses without the typed confirmation, and rename works", async () => {
    const bad = await session(`/api/v1/admin/backups/${first.id}/restore`, { method: "POST", ...json({ confirm: "yes" }) });
    assert(bad.res.status === 400, `restore without phrase: ${bad.res.status}`);
    const none = await session(`/api/v1/admin/backups/${first.id}/restore`, { method: "POST", ...json({}) });
    assert(none.res.status === 400, `restore with empty body: ${none.res.status}`);
    const r = await session(`/api/v1/admin/backups/${first.id}`, { method: "PATCH", ...json({ name: "[smoke] renamed" }) });
    assert(r.res.status === 200 && (await r.res.json()).name === "[smoke] renamed", "rename failed");
  });

  let schedule;
  await test("backups: schedules are validated, get a next run, can be paused, run now, and deleted", async () => {
    const body = { name: "[smoke] nightly", frequency: "daily", time: "03:30", timezone: "Europe/London", keep: 2, includeFiles: false };
    for (const bad of [{ ...body, time: "25:00" }, { ...body, timezone: "Mars/Olympus" }, { ...body, frequency: "hourly" }, { ...body, keep: 0 }, { ...body, extra: 1 }]) {
      const r = await session("/api/v1/admin/backups/schedules", { method: "POST", ...json(bad) });
      assert(r.res.status === 400, `bad schedule accepted: ${JSON.stringify(bad)} -> ${r.res.status}`);
    }
    const created = await session("/api/v1/admin/backups/schedules", { method: "POST", ...json(body) });
    assert(created.res.status === 201 || created.res.status === 200, `create status ${created.res.status}`);
    schedule = await created.res.json();
    schedules.push(schedule.id);
    assert(schedule.enabled === true && new Date(schedule.nextRunAt).getTime() > Date.now(), `schedule ${JSON.stringify(schedule)}`);
    const next = new Date(schedule.nextRunAt);
    assert(next.getTime() - Date.now() < 25 * 3600 * 1000, "next run is more than a day away for a daily schedule");

    const paused = await session(`/api/v1/admin/backups/schedules/${schedule.id}`, { method: "PATCH", ...json({ enabled: false }) });
    const p = await paused.res.json();
    assert(p.enabled === false && p.nextRunAt === null, `paused: ${JSON.stringify(p)}`);
    const resumed = await session(`/api/v1/admin/backups/schedules/${schedule.id}`, { method: "PATCH", ...json({ enabled: true, time: "04:45", keep: 3 }) });
    const r = await resumed.res.json();
    assert(r.enabled && r.time === "04:45" && r.keep === 3 && r.nextRunAt, `resumed: ${JSON.stringify(r)}`);

    const list = await (await session("/api/v1/admin/backups/schedules")).res.json();
    assert(list.some((s) => s.id === schedule.id), "schedule not listed");

    const run = await session(`/api/v1/admin/backups/schedules/${schedule.id}/run`, { method: "POST" });
    assert(run.res.status === 202, `run status ${run.res.status}`);
    const op = await waitFor((await run.res.json()).operationId);
    assert(op.status === "succeeded", `scheduled run ${op.status}: ${op.error}`);
    made.push(op.result.backupId);
    const done = await (await session(`/api/v1/admin/backups/schedules/${schedule.id}`.replace(/\/[^/]+$/, ""))).res.json();
    const mine = done.find((s) => s.id === schedule.id);
    assert(mine.lastStatus === "ok" && mine.lastRunAt, `last run not recorded: ${JSON.stringify(mine)}`);
    const made1 = await (await session(`/api/v1/admin/backups/${op.result.backupId}`)).res.json();
    assert(made1.kind === "scheduled" && made1.scheduleId === schedule.id && made1.scheduleName === "[smoke] nightly", `backup: ${JSON.stringify(made1)}`);

    const del = await session(`/api/v1/admin/backups/schedules/${schedule.id}`, { method: "DELETE" });
    assert(del.res.status === 200, `delete schedule ${del.res.status}`);
    schedules.pop();
    // Deleting a schedule keeps the backups it made.
    const kept = await session(`/api/v1/admin/backups/${op.result.backupId}`);
    assert(kept.res.status === 200, "the schedule's backup vanished with it");
  });

  await test("backups: an API token cannot use them (session only), nor can a malformed id", async () => {
    const t = await session("/api/v1/me/api-tokens", { method: "POST", ...json({ name: "smoke backups", readOnly: false, expiresInDays: 1 }) });
    const tok = await t.res.json();
    const asToken = await fetchWithCookies("/api/v1/admin/backups", { headers: { authorization: `Bearer ${tok.token}` } }, new Map());
    assert(asToken.res.status === 403, `token got ${asToken.res.status}`);
    await session(`/api/v1/me/api-tokens/${tok.id}`, { method: "DELETE" });
    const badId = await session("/api/v1/admin/backups/not-a-uuid");
    assert(badId.res.status === 400, `bad id status ${badId.res.status}`);
    const missing = await session("/api/v1/admin/backups/00000000-0000-4000-8000-000000000000");
    assert(missing.res.status === 404, `missing status ${missing.res.status}`);
  });

  await test("backups: delete removes the backups made by this suite", async () => {
    for (const id of made) {
      const r = await session(`/api/v1/admin/backups/${id}`, { method: "DELETE" });
      assert(r.res.status === 200 || r.res.status === 404, `delete ${id}: ${r.res.status}`);
    }
    const list = await (await session("/api/v1/admin/backups")).res.json();
    const left = list.filter((b) => made.includes(b.id));
    assert(left.length === 0, `${left.length} smoke backups left behind`);
  });
}
