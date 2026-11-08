#!/usr/bin/env node
/**
 * Signage against simulated Pis (tests/signage/fake-pi.sh starts them and runs this). Drives the REAL dashboard code over
 * the API: discovery of a stock Pi by address, setup over a password login (agent install, accounts, the SSH lock-down with
 * its timed undo confirmed by a second key login), the Pi's own state checked with `docker exec`, Apply again (nothing
 * changes), identify, diagnostics, a sudo password asked for and given, and finally removing everything it made.
 *
 * Env: BASE (the proxy), PI_A (stock Pi OS: sudo without a password), PI_B (sudo asks for the password), PI_PASSWORD.
 */
import { execFileSync } from "node:child_process";

const BASE = process.env.BASE ?? "http://localhost:8100";
const PI_A = process.env.PI_A;
const PI_B = process.env.PI_B;
const PI_A_NAME = process.env.PI_A_NAME ?? "church-fake-pi-a";
const PI_B_NAME = process.env.PI_B_NAME ?? "church-fake-pi-b";
const PI_PASSWORD = process.env.PI_PASSWORD ?? "raspberry";
const EMAIL = "regression-test@local";
const FIRST_PASSWORD = "regression-default-pwd";
const PASSWORD = "regression-signage-pwd-1";

let pass = 0;
let fail = 0;
const log = (...a) => console.log(...a);
async function test(name, fn) {
  try {
    await fn();
    pass++;
    log(`  ok    ${name}`);
  } catch (err) {
    fail++;
    log(`  FAIL  ${name}\n        ${err?.message ?? err}`);
  }
}
function assert(c, m) {
  if (!c) throw new Error(m);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const onPi = (container, cmd) => execFileSync("docker", ["exec", container, "sh", "-c", cmd], { encoding: "utf8" });

const jar = new Map();
async function call(path, init = {}) {
  const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}) }, redirect: "manual" });
  for (const sc of res.headers.getSetCookie?.() ?? []) {
    const kv = sc.split(";")[0];
    const i = kv.indexOf("=");
    if (i > 0) {
      const v = kv.slice(i + 1).trim();
      if (v === "" || v === "deleted") jar.delete(kv.slice(0, i).trim());
      else jar.set(kv.slice(0, i).trim(), v);
    }
  }
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, text };
}
const post = (path, body) => call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
const del = (path) => call(path, { method: "DELETE" });

async function signIn(password) {
  jar.clear();
  const csrf = await call("/api/auth/csrf");
  const form = new URLSearchParams({ csrfToken: csrf.body.csrfToken, email: EMAIL, password, callbackUrl: `${BASE}/` });
  await call("/api/auth/callback/credentials", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() });
  return [...jar.keys()].some((k) => k.includes("session-token"));
}

async function waitRun(id, done = ["succeeded", "failed", "needs_sudo"], ms = 240_000) {
  const until = Date.now() + ms;
  let r;
  while (Date.now() < until) {
    r = (await call(`/api/v1/signage/runs/${id}`)).body;
    if (r && done.includes(r.status)) return r;
    await sleep(1500);
  }
  throw new Error(`run ${id} still ${r?.status} (step ${r?.step}):\n${r?.output ?? ""}`);
}

async function foundFor(ip) {
  const list = (await call("/api/v1/signage/discovery/found")).body;
  return Array.isArray(list) ? list.find((f) => f.ip === ip) : undefined;
}

const made = { devices: [], screens: [] };

async function main() {
  assert(PI_A && PI_B, "PI_A and PI_B must be set (run tests/signage/fake-pi.sh)");
  assert(await signIn(FIRST_PASSWORD), "could not sign in as the regression user (make reset-test-user)");
  const ch = await post("/api/v1/me/change-password", { newPassword: PASSWORD });
  assert(ch.status === 200 || ch.status === 201, `change password ${ch.status}`);
  assert(await signIn(PASSWORD), "could not sign in again after the password change");

  let key;
  await test("the dashboard has a signage key", async () => {
    const r = await call("/api/v1/signage/key");
    assert(r.status === 200 && /^ssh-ed25519 /.test(r.body.publicKey ?? ""), `key: ${r.text}`);
    key = r.body.publicKey;
  });

  await test("adding the Pis by address finds them as stock Raspberry Pis", async () => {
    const r = await post("/api/v1/signage/discovery/ips", { ips: [PI_A, PI_B] });
    assert(r.status === 200 || r.status === 201, `add ips ${r.status}: ${r.text}`);
    assert(r.body.unreachable.length === 0, `unreachable: ${r.body.unreachable}`);
    // Only a continuous scan marks a Pi "new"; one typed in by address is expected.
    const a = await foundFor(PI_A);
    assert(a && a.hostKey && a.evidence && !a.knownDeviceId, `found: ${JSON.stringify(a)}`);
  });

  let deviceA;
  let screenA;
  await test("setup of Pi A (stock sudo) succeeds: agent installed, settings applied and confirmed", async () => {
    const f = await foundFor(PI_A);
    const r = await post("/api/v1/signage/setup", { foundId: f.id, name: "Fake Pi A", newScreenName: "[fake-pi] Lobby", username: "pi", password: PI_PASSWORD });
    assert(r.status === 202 || r.status === 201 || r.status === 200, `setup ${r.status}: ${r.text}`);
    assert(!r.text.includes(PI_PASSWORD), "the password came back in the answer");
    const run = await waitRun(r.body.id);
    if (run.deviceId) made.devices.push(run.deviceId);
    assert(run.status === "succeeded", `run ${run.status}: ${run.error}\n${run.output}`);
    assert(!run.output.includes(PI_PASSWORD), "the password is in the run log");
    const d = (await call(`/api/v1/signage/devices/${run.deviceId}`)).body;
    if (d.screenId) made.screens.push(d.screenId);
    assert(d.status === "active", `device status ${d.status}: ${d.lastError}`);
    assert(d.settingsApplied === true, `settingsApplied: ${JSON.stringify(d)}`);
    assert(d.agentVersion, "no agent version reported");
    assert(d.hostKey, "host key not pinned");
    deviceA = d;
    screenA = d.screenId;
  });

  await test("Pi A is locked down: key login only, the dashboard's key, the agent in place", async () => {
    assert(deviceA, "no device");
    const sshd = onPi(PI_A_NAME, "sshd -T -C user=pi,host=x,addr=10.0.0.1 2>/dev/null | grep -iE '^(passwordauthentication|permitrootlogin|kbdinteractiveauthentication) '");
    assert(/passwordauthentication no/i.test(sshd), `sshd: ${sshd}`);
    assert(/permitrootlogin no/i.test(sshd), `sshd: ${sshd}`);
    const login = deviceA.loginUser;
    const ak = onPi(PI_A_NAME, `cat ~${login}/.ssh/authorized_keys`);
    assert(ak.includes(key.split(" ")[1]), `authorized_keys has no dashboard key:\n${ak}`);
    assert(/command="\/usr\/local\/bin\/signage-ctl"/.test(ak) && /restrict/.test(ak), `key is not restricted:\n${ak}`);
    assert(onPi(PI_A_NAME, "test -x /usr/local/bin/signage-ctl && echo yes").trim() === "yes", "signage-ctl missing");
    const pending = onPi(PI_A_NAME, "ls /var/lib/signage/pending 2>/dev/null | wc -l").trim();
    assert(pending === "0", `an undo is still pending (${pending}): the confirm did not happen`);
  });

  await test("Pi A refuses a password login now", async () => {
    const out = onPi(PI_B_NAME, `command -v sshpass >/dev/null || exit 3; sshpass -p '${PI_PASSWORD}' ssh -o StrictHostKeyChecking=no -o PubkeyAuthentication=no -o ConnectTimeout=5 pi@${PI_A} true >/dev/null 2>&1; echo $?`).trim();
    assert(out !== "0", "a password login to Pi A still works");
  });

  await test("Apply again changes nothing and still confirms", async () => {
    const r = await post(`/api/v1/signage/devices/${deviceA.id}/apply`, {});
    assert(r.status < 300, `apply ${r.status}: ${r.text}`);
    const run = await waitRun(r.body.id);
    assert(run.status === "succeeded", `apply run ${run.status}: ${run.error}\n${run.output}`);
    assert(/already/i.test(run.output), `expected "already" lines:\n${run.output}`);
  });

  await test("with the firewall setting on, Pi A takes SSH only from the dashboard", async () => {
    const before = (await call("/api/v1/settings/signage.pi_firewall")).body?.value ?? null;
    try {
      const s = await call("/api/v1/settings/signage.pi_firewall", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: true }) });
      assert(s.status < 300, `setting ${s.status}: ${s.text}`);
      const r = await post(`/api/v1/signage/devices/${deviceA.id}/apply`, {});
      assert(r.status < 300, `apply ${r.status}: ${r.text}`);
      const run = await waitRun(r.body.id);
      assert(run.status === "succeeded", `apply run ${run.status}: ${run.error}\n${run.output}`);
      const rules = onPi(PI_A_NAME, "nft list table inet church_signage");
      assert(/dport 22/.test(rules), `no SSH rule:\n${rules}`);
      const fromB = onPi(PI_B_NAME, `timeout 4 bash -c 'exec 3<>/dev/tcp/${PI_A}/22' >/dev/null 2>&1; echo $?`).trim();
      assert(fromB !== "0", "Pi B can still open SSH on Pi A");
      const diag = await post(`/api/v1/signage/devices/${deviceA.id}/command`, { type: "diag" });
      assert(diag.status < 300, `the dashboard cannot reach Pi A through its firewall: ${diag.status} ${diag.text}`);
    } finally {
      if (before === null) await del("/api/v1/settings/signage.pi_firewall");
      else await call("/api/v1/settings/signage.pi_firewall", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: before }) });
      const r = await post(`/api/v1/signage/devices/${deviceA.id}/apply`, {});
      if (r.status < 300) await waitRun(r.body.id);
    }
    const gone = onPi(PI_A_NAME, "nft list table inet church_signage >/dev/null 2>&1; echo $?").trim();
    assert(gone !== "0", "the firewall stayed after the setting was turned off");
  });

  await test("identify shows a 3-digit code on Pi A", async () => {
    const r = await post("/api/v1/signage/identify", { deviceIds: [deviceA.id], seconds: 30 });
    assert(r.status < 300, `identify ${r.status}: ${r.text}`);
    const row = r.body.devices.find((x) => x.deviceId === deviceA.id);
    assert(row && /^\d{3}$/.test(row.code ?? ""), `identify: ${r.text}`);
    const onDisk = onPi(PI_A_NAME, "cat /run/signage/identify.json");
    assert(onDisk.includes(row.code), `identify.json: ${onDisk}`);
    const off = await post("/api/v1/signage/identify/off", { deviceIds: [deviceA.id] });
    assert(off.status < 300, `identify off ${off.status}: ${off.text}`);
  });

  await test("diagnostics answer over the forced command", async () => {
    const r = await post(`/api/v1/signage/devices/${deviceA.id}/command`, { type: "diag" });
    assert(r.status < 300, `diag ${r.status}: ${r.text}`);
  });

  await test("a status poll records the Pi as online", async () => {
    const until = Date.now() + 90_000;
    let d;
    while (Date.now() < until) {
      d = (await call(`/api/v1/signage/devices/${deviceA.id}`)).body;
      if (d.online) break;
      await sleep(3000);
    }
    assert(d.online, `not online: ${JSON.stringify(d)}`);
  });

  await test("the screen gets a manifest after a sync", async () => {
    const r = await post(`/api/v1/signage/devices/${deviceA.id}/command`, { type: "sync_now" });
    assert(r.status < 300, `sync ${r.status}: ${r.text}`);
    const until = Date.now() + 60_000;
    let ok = false;
    while (Date.now() < until && !ok) {
      ok = onPi(PI_A_NAME, "test -s /var/lib/signage/manifest.json && echo yes || true").trim() === "yes";
      if (!ok) await sleep(2000);
    }
    assert(ok, "no manifest on the Pi");
  });

  await test("Pi B (sudo asks for a password): the run waits for it, then finishes once it is given", async () => {
    const f = await foundFor(PI_B);
    // The run does not get the sudo password at first: the setup login's password is tried for sudo, so use a Pi whose
    // sudo password differs from its login password.
    const r = await post("/api/v1/signage/setup", { foundId: f.id, name: "Fake Pi B", screenId: null, username: "pi", password: PI_PASSWORD });
    assert(r.status < 300, `setup ${r.status}: ${r.text}`);
    let run = await waitRun(r.body.id);
    if (run.deviceId) made.devices.push(run.deviceId);
    assert(run.deviceId && run.deviceId !== deviceA.id, "Pi B was taken for Pi A (same host key?)");
    assert(run.status === "needs_sudo", `expected needs_sudo, got ${run.status}: ${run.error}\n${run.output}`);
    const g = await post(`/api/v1/signage/runs/${run.id}/sudo`, { sudoPassword: "sudo-secret-b" });
    assert(g.status < 300, `sudo ${g.status}: ${g.text}`);
    run = await waitRun(run.id, ["succeeded", "failed"]);
    assert(run.status === "succeeded", `run ${run.status}: ${run.error}\n${run.output}`);
    assert(!run.output.includes("sudo-secret-b"), "the sudo password is in the run log");
  });

  await test("rotating the key keeps every Pi reachable", async () => {
    const r = await post("/api/v1/signage/key/rotate", {});
    assert(r.status < 300, `rotate ${r.status}: ${r.text}`);
    assert(r.body.queued === 2 && r.body.notQueued.length === 0, `rotation queued: ${r.text}`);
    const newKey = (await call("/api/v1/signage/key")).body.publicKey;
    assert(newKey && newKey !== key, "the key did not change");
    const until = Date.now() + 180_000;
    let ak = "";
    while (Date.now() < until) {
      ak = onPi(PI_A_NAME, `cat ~${deviceA.loginUser}/.ssh/authorized_keys`);
      if (ak.includes(newKey.split(" ")[1]) && !ak.includes(key.split(" ")[1])) break;
      await sleep(3000);
    }
    assert(ak.includes(newKey.split(" ")[1]), `new key not on Pi A:\n${ak}`);
    assert(!ak.includes(key.split(" ")[1]), `old key still on Pi A:\n${ak}`);
    const diag = await post(`/api/v1/signage/devices/${deviceA.id}/command`, { type: "diag" });
    assert(diag.status < 300, `diag after rotation ${diag.status}: ${diag.text}`);
  });
}

async function cleanup() {
  for (const id of made.devices) await del(`/api/v1/signage/devices/${id}`).catch(() => undefined);
  for (const id of made.screens) await del(`/api/v1/signage/screens/${id}`).catch(() => undefined);
  for (const ip of [PI_A, PI_B]) {
    const f = await foundFor(ip).catch(() => undefined);
    if (f) await post(`/api/v1/signage/discovery/found/${f.id}/dismiss`).catch(() => undefined);
  }
}

try {
  await main();
} catch (err) {
  fail++;
  log(`  FAIL  ${err?.message ?? err}`);
} finally {
  await cleanup();
}
log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
