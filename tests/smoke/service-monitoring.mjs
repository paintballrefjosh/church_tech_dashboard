/**
 * Service monitoring smoke tests, run from run.mjs (docs/service-monitoring.md). Nothing here reaches a real service: the
 * host made is switched off (so the poller never reads it) and on 127.0.0.1, and every test run points at an address the
 * dashboard refuses to contact. It proves the doors (a session, the Monitoring tiers, logins only for writers), that a
 * secret and a login's password are never returned or audited, that commands must be confirmed to save, add or test a
 * template that runs them, and that a test cannot be aimed at this server. Everything made here is removed before the end.
 */
export async function serviceMonitoringTests({ test, assert, fetchWithCookies, jar }) {
  const json = (body) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const admin = (path, init = {}) => fetchWithCookies(path, init, jar);
  const stamp = Date.now();
  const key = `smoke-${stamp}`;
  let hostId = null;
  let loginId = null;
  let instanceId = null;
  let groupId = null;
  let templateSaved = false;
  let volunteer = null;
  const commandBody = {
    name: "[smoke] command template",
    inputs: [],
    collect: { s: { transport: "ssh", command: "systemctl is-active nginx", parse: { type: "lines" } } },
    metrics: { up: { from: "s", where: "line == 'active'", agg: "count" } },
    checks: [],
  };

  try {
    await test("service monitoring: needs a session", async () => {
      const { res } = await fetchWithCookies("/api/v1/service-monitoring/templates");
      assert(res.status === 401, `gave ${res.status}`);
    });

    await test("service monitoring: the built-in templates are listed, with which run commands", async () => {
      const { res } = await admin("/api/v1/service-monitoring/templates");
      assert(res.status === 200, `templates ${res.status}`);
      const list = await res.json();
      const byKey = new Map(list.map((t) => [t.key, t]));
      for (const k of ["haproxy", "postgresql", "mysql", "kea", "technitium", "json-value", "systemd-unit", "redis", "nginx", "rabbitmq", "chrony", "postfix", "mdadm", "zfs", "systemd-failed", "garage", "meilisearch"]) {
        assert(byKey.has(k), `no built-in ${k}`);
      }
      assert(byKey.get("haproxy").source === "builtin" && byKey.get("systemd-unit").runsCommands === true, "built-in flags");
      const del = await admin("/api/v1/service-monitoring/templates/haproxy", { method: "DELETE" });
      assert(del.res.status === 409, `deleting a built-in gave ${del.res.status}`);
    });

    await test("service monitoring: a template that runs commands is saved only with its commands confirmed", async () => {
      const bare = await admin(`/api/v1/service-monitoring/templates/${key}`, { method: "PUT", ...json({ body: commandBody }) });
      assert(bare.res.status === 409, `unconfirmed save gave ${bare.res.status}`);
      const answer = await bare.res.json();
      assert(answer.code === "confirm_commands" && answer.commands[0] === "s: systemctl is-active nginx", `409 body ${JSON.stringify(answer)}`);
      const wrong = await admin(`/api/v1/service-monitoring/templates/${key}`, { method: "PUT", ...json({ body: commandBody, confirmCommands: ["s: true"] }) });
      assert(wrong.res.status === 409, `a different confirmation gave ${wrong.res.status}`);
      const ok = await admin(`/api/v1/service-monitoring/templates/${key}`, { method: "PUT", ...json({ body: commandBody, confirmCommands: answer.commands }) });
      assert(ok.res.status === 200, `confirmed save gave ${ok.res.status}: ${await ok.res.clone().text()}`);
      templateSaved = true;
      assert((await ok.res.json()).runsCommands === true, "runsCommands");
      const bad = await admin(`/api/v1/service-monitoring/templates/${key}-bad`, { method: "PUT", ...json({ body: { ...commandBody, metrics: { up: { from: "nowhere", agg: "count" } } } }) });
      assert(bad.res.status === 400, `a broken template gave ${bad.res.status}`);
    });

    await test("service monitoring: a login's password is kept and never returned or audited", async () => {
      const secret = `smoke-login-pw-${stamp}`;
      const { res } = await admin("/api/v1/service-monitoring/logins", { method: "POST", ...json({ name: `[smoke] login ${stamp}`, username: "monitor", password: secret }) });
      const text = await res.text();
      assert(res.status === 200 || res.status === 201, `create login ${res.status}: ${text}`);
      assert(!text.includes(secret), "the password came back");
      const login = JSON.parse(text);
      loginId = login.id;
      assert(login.hasPassword === true, "hasPassword");
      const keep = await admin(`/api/v1/service-monitoring/logins/${loginId}`, { method: "PATCH", ...json({ name: login.name, username: "monitor", password: "[saved]" }) });
      assert(keep.res.status === 200 && (await keep.res.json()).hasPassword === true, "[saved] keeps the password");
      const list = await admin("/api/v1/service-monitoring/logins").then(({ res: r }) => r.text());
      assert(!list.includes(secret), "the password is in the list");
      const audit = await admin(`/api/v1/audit?resourceType=service_login`).then(({ res: r }) => r.text());
      assert(!audit.includes(secret), "the password is in the audit log");
    });

    await test("service monitoring: a switched-off service keeps its secret to itself and is not checked", async () => {
      const host = await admin("/api/v1/infra/targets", { method: "POST", ...json({ name: `[smoke] service host ${stamp}`, os: "linux", host: "127.0.0.1", enabled: false }) });
      assert(host.res.status === 200 || host.res.status === 201, `create host ${host.res.status}`);
      hostId = (await host.res.json()).id;
      const token = `smoke-svc-token-${stamp}`;
      const { res } = await admin("/api/v1/service-monitoring/instances", {
        method: "POST",
        ...json({ targetId: hostId, templateKey: "technitium", name: `[smoke] dns ${stamp}`, inputs: { port: 5380 }, secrets: { token }, intervalSec: 300, enabled: false }),
      });
      const text = await res.text();
      assert(res.status === 200 || res.status === 201, `create service ${res.status}: ${text}`);
      assert(!text.includes(token), "the secret came back");
      const inst = JSON.parse(text);
      instanceId = inst.id;
      assert(inst.secrets.token === "[saved]" && inst.status === "disabled", `new service ${text}`);
      const list = await admin(`/api/v1/service-monitoring/instances?targetId=${hostId}`).then(({ res: r }) => r.text());
      assert(list.includes(instanceId) && !list.includes(token), "list");
      const audit = await admin(`/api/v1/audit?resourceType=service_instance&resourceId=${instanceId}`).then(({ res: r }) => r.text());
      assert(!audit.includes(token), "the secret is in the audit log");
      const poll = await admin(`/api/v1/service-monitoring/instances/${instanceId}/poll-now`, { method: "POST" });
      assert(poll.res.status === 409, `check now on a switched-off service gave ${poll.res.status}`);
      for (const p of ["series", "incidents"]) {
        const r = await admin(`/api/v1/service-monitoring/instances/${instanceId}/${p}`);
        assert(r.res.status === 200, `${p} ${r.res.status}`);
      }
      const unconfirmed = await admin("/api/v1/service-monitoring/instances", {
        method: "POST",
        ...json({ targetId: hostId, templateKey: key, name: "[smoke] commands", inputs: {}, secrets: {}, enabled: false }),
      });
      assert(unconfirmed.res.status === 409, `adding a command template unconfirmed gave ${unconfirmed.res.status}`);
    });

    await test("service monitoring: a group of services is saved, audited, judged and shown on the home page", async () => {
      assert(instanceId, "needs the service made above");
      const name = `[smoke] group ${stamp}`;
      const tooMany = await admin("/api/v1/service-monitoring/groups", { method: "POST", ...json({ name, minHealthy: 2, instanceIds: [instanceId] }) });
      assert(tooMany.res.status === 400, `a quorum above the members gave ${tooMany.res.status}`);
      const badRole = await admin("/api/v1/service-monitoring/groups", { method: "POST", ...json({ name, role: { metric: "role", value: "MASTER", min: 1, max: 1 }, instanceIds: [instanceId] }) });
      assert(badRole.res.status === 400, `a role the members cannot report gave ${badRole.res.status}`);
      const { res } = await admin("/api/v1/service-monitoring/groups", { method: "POST", ...json({ name, minHealthy: 1, instanceIds: [instanceId] }) });
      assert(res.status === 200 || res.status === 201, `create group ${res.status}: ${await res.clone().text()}`);
      const g = await res.json();
      groupId = g.id;
      // Its one service is switched off (its host is), so there is nothing to judge.
      assert(g.status === "unknown" && g.counted === 0 && g.members.length === 1, `group ${JSON.stringify(g)}`);
      const dup = await admin("/api/v1/service-monitoring/groups", { method: "POST", ...json({ name }) });
      assert(dup.res.status === 409, `a second group with the name gave ${dup.res.status}`);
      const inst = await admin(`/api/v1/service-monitoring/instances/${instanceId}`).then(({ res: r }) => r.json());
      assert(inst.groupId === groupId && inst.groupName === name, "the service names its group");
      const audit = await admin(`/api/v1/audit?resourceType=service_group`).then(({ res: r }) => r.json());
      const rows = audit.items ?? audit.rows ?? audit;
      assert(Array.isArray(rows) && rows.some((r) => r.action === "service.group.create" && r.resourceId === groupId), "no audit row for the group");
      const home = await admin("/api/v1/dashboard/home").then(({ res: r }) => r.json());
      if (home.systems.state === "ok") {
        const area = home.systems.data.areas.find((a) => a.key === "services");
        assert(area && area.href === "/monitoring/infra/service-groups", `no services area: ${JSON.stringify(home.systems.data.areas.map((a) => a.key))}`);
      }
      const upd = await admin(`/api/v1/service-monitoring/groups/${groupId}`, { method: "PUT", ...json({ name, minHealthy: null, instanceIds: [] }) });
      assert(upd.res.status === 200 && (await upd.res.json()).members.length === 0, "emptying the group");
      const after = await admin(`/api/v1/service-monitoring/instances/${instanceId}`).then(({ res: r }) => r.json());
      assert(after.groupId === null, "the service left the group");
    });

    await test("service monitoring: a test run needs the commands confirmed and cannot reach this server", async () => {
      const cmd = await admin("/api/v1/service-monitoring/test", { method: "POST", ...json({ targetId: hostId, templateKey: key, inputs: {}, secrets: {} }) });
      assert(cmd.res.status === 409, `an unconfirmed command test gave ${cmd.res.status}`);
      for (const url of ["http://127.0.0.1:3001/api/v1/me", "http://api:3001/api/v1/me", "http://169.254.169.254/latest/meta-data"]) {
        const { res } = await admin("/api/v1/service-monitoring/test", {
          method: "POST",
          ...json({ targetId: hostId, templateKey: "json-value", inputs: { url, path: "id" }, secrets: {} }),
        });
        assert(res.status === 200 || res.status === 201, `test ${url} gave ${res.status}`);
        const r = await res.json();
        assert(r.down === true && r.collectors.every((c) => c.error && c.rows === 0), `${url} was read: ${JSON.stringify(r)}`);
      }
    });

    await test("service monitoring: a volunteer reads services but cannot add one or see logins", async () => {
      const email = `svcmon-volunteer-${stamp}@example.com`;
      const password = "smoke-volunteer-pw-1234";
      const created = await admin("/api/v1/users", {
        method: "POST",
        ...json({ email, displayName: "Service Monitoring Volunteer Smoke", password, sendInvite: false, sendWelcomeEmail: false, mustChangePassword: false }),
      });
      assert(created.res.status === 200 || created.res.status === 201, `create user ${created.res.status}`);
      volunteer = { user: await created.res.json(), groupId: null };
      const group = await admin("/api/v1/groups", { method: "POST", ...json({ name: `svcmon-smoke-${stamp}`, description: "smoke" }) });
      volunteer.groupId = (await group.res.json()).id;
      await admin(`/api/v1/groups/${volunteer.groupId}/module-access`, { method: "PUT", ...json({ access: { monitoring: "user" } }) });
      await admin(`/api/v1/groups/${volunteer.groupId}/members`, { method: "POST", ...json({ userId: volunteer.user.id }) });
      const j = new Map();
      const csrf = await fetchWithCookies("/api/auth/csrf", {}, j).then(({ res }) => res.json());
      await fetchWithCookies(
        "/api/auth/callback/credentials",
        { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrfToken: csrf.csrfToken, email, password, callbackUrl: "/", json: "true" }).toString() },
        j,
      );
      const me = await fetchWithCookies("/api/v1/me", {}, j).then(({ res }) => res.json());
      if (me.permissions.includes("monitors:write:any")) return; // every account here may change monitoring; nothing to prove
      assert(me.permissions.includes("monitors:read:any"), "the volunteer should read monitoring");
      const read = await fetchWithCookies(`/api/v1/service-monitoring/instances/${instanceId}`, {}, j);
      assert(read.res.status === 200, `volunteer read ${read.res.status}`);
      if (groupId) {
        const g = await fetchWithCookies(`/api/v1/service-monitoring/groups/${groupId}`, {}, j);
        assert(g.res.status === 200, `volunteer group read ${g.res.status}`);
        const del = await fetchWithCookies(`/api/v1/service-monitoring/groups/${groupId}`, { method: "DELETE" }, j);
        assert(del.res.status === 403, `volunteer group delete gave ${del.res.status}`);
      }
      const logins = await fetchWithCookies("/api/v1/service-monitoring/logins", {}, j);
      assert(logins.res.status === 403, `volunteer logins gave ${logins.res.status}`);
      const add = await fetchWithCookies("/api/v1/service-monitoring/instances", { method: "POST", ...json({ targetId: hostId, templateKey: "json-value", name: "x", inputs: {}, secrets: {} }) }, j);
      assert(add.res.status === 403, `volunteer add gave ${add.res.status}`);
      const t = await fetchWithCookies("/api/v1/service-monitoring/test", { method: "POST", ...json({ targetId: hostId, templateKey: "json-value", inputs: {}, secrets: {} }) }, j);
      assert(t.res.status === 403, `volunteer test gave ${t.res.status}`);
    });
  } finally {
    if (groupId) await admin(`/api/v1/service-monitoring/groups/${groupId}`, { method: "DELETE" });
    if (instanceId) await admin(`/api/v1/service-monitoring/instances/${instanceId}`, { method: "DELETE" });
    if (templateSaved) await admin(`/api/v1/service-monitoring/templates/${key}`, { method: "DELETE" });
    if (loginId) await admin(`/api/v1/service-monitoring/logins/${loginId}`, { method: "DELETE" });
    if (hostId) await admin(`/api/v1/infra/targets/${hostId}`, { method: "DELETE" });
    if (volunteer) {
      if (volunteer.groupId) await admin(`/api/v1/groups/${volunteer.groupId}`, { method: "DELETE" });
      await admin(`/api/v1/users/${volunteer.user.id}`, { method: "DELETE" });
      await admin(`/api/v1/users/${volunteer.user.id}/hard-delete`, { method: "POST" });
    }
  }
}
