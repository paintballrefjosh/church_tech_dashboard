/**
 * Alerting smoke tests, run from run.mjs: the status page, acknowledging an incident and the escalation settings.
 * Every monitor made here is deleted before the block ends (their incidents go with them). The one monitor that
 * is allowed to fail points at a closed port on the probe worker's own host, so nothing else is touched.
 */
export async function alertTests({ test, assert, fetchWithCookies, jar }) {
  const json = (body) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const session = (path, init = {}) => fetchWithCookies(path, init, jar);
  const bearer = (token, path, init = {}) =>
    fetchWithCookies(path, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` } }, new Map());
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const made = [];
  let token = null;

  const makeMonitor = async (body) => {
    const { res } = await session("/api/v1/monitors", { method: "POST", ...json(body) });
    const text = await res.text();
    assert(res.status === 201 || res.status === 200, `create status ${res.status}: ${text}`);
    const row = JSON.parse(text);
    made.push(row.id);
    return row;
  };
  const readStatus = async () => {
    const { res } = await session("/api/v1/status");
    assert(res.status === 200, `status ${res.status}`);
    return res.json();
  };

  try {
    await test("status: needs a session", async () => {
      const { res } = await fetchWithCookies("/api/v1/status");
      assert(res.status === 401, `status ${res.status}`);
    });

    let listed;
    await test("status: lists only monitors marked for it, under the plain name, never the address", async () => {
      listed = await makeMonitor({
        name: "[smoke] alerts listed",
        kind: "tcp",
        target: "127.0.0.1:9",
        intervalSec: 10,
        failThreshold: 1,
        recoverThreshold: 1,
        showOnStatus: true,
        statusName: "Smoke Plain Name",
      });
      assert(listed.showOnStatus === true && listed.statusName === "Smoke Plain Name", `monitor: ${JSON.stringify(listed)}`);
      await makeMonitor({ name: "[smoke] alerts hidden", kind: "tcp", target: "127.0.0.1:9", intervalSec: 3600 });
      const page = await readStatus();
      const names = page.items.map((i) => i.name);
      assert(names.includes("Smoke Plain Name"), `names: ${names.join(", ")}`);
      assert(!names.some((n) => n.includes("alerts hidden") || n.includes("alerts listed")), "a monitor's real name or an unmarked one leaked");
      const text = JSON.stringify(page);
      assert(!text.includes("127.0.0.1") && !text.includes("refused"), "the address or error text leaked");
      assert(["ok", "degraded", "outage", "unknown"].includes(page.overall), `overall ${page.overall}`);
      assert(typeof page.maintenance.enabled === "boolean" && typeof page.notice === "string", "shape");
    });

    await test("runbook: a monitor links a wiki page; a page that does not exist is refused; deleting the page clears it", async () => {
      const made = await session("/api/v1/wiki", { method: "POST", ...json({ title: "[smoke] runbook", body: "Restart the encoder." }) });
      assert(made.res.status === 201 || made.res.status === 200, `wiki create ${made.res.status}`);
      const page = await made.res.json();
      const bogus = await session(`/api/v1/monitors/${listed.id}`, { method: "PATCH", ...json({ runbookPageId: "00000000-0000-4000-8000-000000000000" }) });
      assert(bogus.res.status === 400, `missing page: ${bogus.res.status}`);
      const linked = await session(`/api/v1/monitors/${listed.id}`, { method: "PATCH", ...json({ runbookPageId: page.id }) });
      assert(linked.res.status === 200 && (await linked.res.json()).runbookPageId === page.id, "link not stored");
      await session(`/api/v1/wiki/${page.id}`, { method: "DELETE" });
      const after = await (await session(`/api/v1/monitors/${listed.id}`)).res.json();
      assert(after.runbookPageId === null, `link survived the page: ${after.runbookPageId}`);
    });

    await test("status: a token limited to notes can still read it (no monitoring access needed)", async () => {
      const { res } = await session("/api/v1/me/api-tokens", { method: "POST", ...json({ name: "smoke status", modules: ["notes"], expiresInDays: 1 }) });
      assert(res.status === 201 || res.status === 200, `create status ${res.status}`);
      token = await res.json();
      const status = await bearer(token.token, "/api/v1/status");
      assert(status.res.status === 200, `status ${status.res.status}`);
      const monitors = await bearer(token.token, "/api/v1/monitors");
      assert(monitors.res.status === 403, `the monitor list should stay closed to it, got ${monitors.res.status}`);
    });

    let incident;
    await test("incidents: a failing monitor opens one, and it can be acknowledged (twice is harmless)", async () => {
      const deadline = Date.now() + 90_000;
      for (;;) {
        const { res } = await session(`/api/v1/monitors/${listed.id}/incidents`);
        assert(res.status === 200, `incidents status ${res.status}`);
        const rows = await res.json();
        incident = rows.find((r) => !r.resolvedAt);
        if (incident) break;
        assert(Date.now() < deadline, "no incident opened within 90 s");
        await sleep(2000);
      }
      assert(!incident.acknowledgedAt && incident.escalationLevel === 0, `fresh incident: ${JSON.stringify(incident)}`);
      const me = await (await session("/api/v1/me")).res.json();
      const first = await session(`/api/v1/monitors/incidents/${incident.id}/ack`, { method: "POST" });
      assert(first.res.status === 201 || first.res.status === 200, `ack status ${first.res.status}`);
      const body = await first.res.json();
      assert(body.acknowledgedAt && body.acknowledgedBy === me.id, `ack: ${JSON.stringify(body)}`);
      const second = await session(`/api/v1/monitors/incidents/${incident.id}/ack`, { method: "POST" });
      assert((await second.res.json()).acknowledgedAt === body.acknowledgedAt, "a second ack changed the time");
    });

    await test("incidents: the probe worker's down alert reaches the bell (through the alert outbox)", async () => {
      // The worker queues its alerts in alert_outbox and the API's alert-dispatch job tells people through the ordinary
      // notification path. Until 2026-10-25 the worker wrote bell rows itself, so these never sent an email or a push.
      const maint = await (await session("/api/v1/monitors/maintenance")).res.json();
      if (maint.enabled) return; // alerts are paused on this stack: nothing to see
      const deadline = Date.now() + 30_000;
      for (;;) {
        const { res } = await session("/api/v1/notifications?limit=50");
        assert(res.status === 200, `notifications status ${res.status}`);
        const rows = await res.json();
        if (rows.some((n) => n.kind === "monitor.incident.opened" && n.title === `${listed.name} is down`)) break;
        assert(Date.now() < deadline, "the down alert did not reach the bell within 30 s");
        await sleep(2000);
      }
    });

    await test("status: the acknowledged outage is shown as down with somebody on it", async () => {
      const page = await readStatus();
      const item = page.items.find((i) => i.name === "Smoke Plain Name");
      assert(item && item.state === "down" && item.acknowledged === true && item.since, `item: ${JSON.stringify(item)}`);
      assert(page.overall === "outage" || page.overall === "degraded", `overall ${page.overall}`);
    });

    await test("incidents: unknown ids are a 404 and a malformed one a 400; a token without write access cannot acknowledge", async () => {
      const missing = await session("/api/v1/monitors/incidents/00000000-0000-4000-8000-000000000000/ack", { method: "POST" });
      assert(missing.res.status === 404, `missing status ${missing.res.status}`);
      const bad = await session("/api/v1/monitors/incidents/not-an-id/ack", { method: "POST" });
      assert(bad.res.status === 400, `malformed status ${bad.res.status}`);
      const viaToken = await bearer(token.token, `/api/v1/monitors/incidents/${incident.id}/ack`, { method: "POST" });
      assert(viaToken.res.status === 403, `token status ${viaToken.res.status}`);
    });

    await test("settings: the escalation group must exist; minutes and the flap count are range checked", async () => {
      const put = (key, value) => session(`/api/v1/settings/${key}`, { method: "PUT", ...json({ value }) });
      const nope = await put("monitoring.escalation_group", "No Such Group Anywhere");
      assert(nope.res.status === 400, `unknown group status ${nope.res.status}`);
      assert((await put("monitoring.escalation_group", "")).res.status === 200, "blank should be accepted");
      assert((await put("monitoring.escalate_reminder_min", -1)).res.status === 400, "negative minutes");
      assert((await put("monitoring.escalate_reminder_min", 1441)).res.status === 400, "more than a day");
      assert((await put("monitoring.flap_incidents", 99)).res.status === 400, "flap count too high");
      assert((await put("monitoring.flap_incidents", 3)).res.status === 200, "default flap count");
    });

    await test("public status: 404 while off; when on, readable without signing in and without monitor ids", async () => {
      const put = (value) => session("/api/v1/settings/monitoring.status_public", { method: "PUT", ...json({ value }) });
      try {
        assert((await put(false)).res.status === 200, "switch off");
        assert((await fetchWithCookies("/api/v1/status/public")).res.status === 404, "public copy while off");
        assert((await fetchWithCookies("/public-status")).res.status === 404, "public page while off");
        assert((await put(true)).res.status === 200, "switch on");
        const { res } = await fetchWithCookies("/api/v1/status/public");
        assert(res.status === 200, `public copy ${res.status}`);
        const body = await res.json();
        assert(Array.isArray(body.items) && body.items.every((i) => !("id" in i)), `ids leaked: ${JSON.stringify(body.items)}`);
        assert(body.items.some((i) => i.name === listed.statusName || i.name === listed.name), "the listed monitor is missing");
        assert((await fetchWithCookies("/public-status")).res.status === 200, "public page while on");
      } finally {
        await put(false);
      }
    });

    await test("status: the admin's notice is shown (and cleared)", async () => {
      const put = (value) => session("/api/v1/settings/monitoring.status_notice", { method: "PUT", ...json({ value }) });
      assert((await put("[smoke] Wi-Fi work on Saturday")).res.status === 200, "set notice");
      assert((await readStatus()).notice === "[smoke] Wi-Fi work on Saturday", "notice not shown");
      assert((await put("")).res.status === 200, "clear notice");
      assert((await readStatus()).notice === "", "notice not cleared");
    });
  } finally {
    for (const id of made) await session(`/api/v1/monitors/${id}`, { method: "DELETE" }).catch(() => undefined);
    if (token) await session(`/api/v1/me/api-tokens/${token.id}`, { method: "DELETE" }).catch(() => undefined);
  }
}
