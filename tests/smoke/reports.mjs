/**
 * Monthly report, guest vouchers and Protect cameras smoke tests, run from run.mjs. Read-only against any real controller:
 * a voucher is never created here, only refused for bad input before anything is sent.
 */
export async function reportTests({ test, assert, fetchWithCookies, jar }) {
  const json = (body) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const session = (path, init = {}) => fetchWithCookies(path, init, jar);

  await test("monthly report: needs a session; a site admin reads any month; a bad month is refused", async () => {
    assert((await fetchWithCookies("/api/v1/reports/monthly")).res.status === 401, "no session");
    const { res } = await session("/api/v1/reports/monthly?month=2026-09");
    assert(res.status === 200, `report ${res.status}`);
    const r = await res.json();
    assert(r.month === "2026-09" && Array.isArray(r.services) && typeof r.tickets.opened === "number", JSON.stringify(r).slice(0, 200));
    assert((await session("/api/v1/reports/monthly?month=2026-13")).res.status === 400, "bad month");
  });

  await test("guest vouchers: bad input is refused before anything reaches the controller", async () => {
    const tooMany = await session("/api/v1/unifi/vouchers", { method: "POST", ...json({ count: 500, minutes: 60 }) });
    assert(tooMany.res.status === 400, `500 vouchers: ${tooMany.res.status}`);
    const badId = await session("/api/v1/unifi/vouchers/not-an-id", { method: "DELETE" });
    assert(badId.res.status === 400, `bad id: ${badId.res.status}`);
    const list = await session("/api/v1/unifi/vouchers");
    assert([200, 503].includes(list.res.status), `list: ${list.res.status}`);
  });

  await test("Protect cameras: reports switched off (or the cameras) without failing", async () => {
    const { res } = await session("/api/v1/unifi/cameras");
    assert(res.status === 200, `cameras ${res.status}`);
    const body = await res.json();
    assert(typeof body.enabled === "boolean" && Array.isArray(body.cameras), JSON.stringify(body));
  });

  await test("monitors: a schedule that cannot be read and an HLS target that is not a URL are refused", async () => {
    const bad = await session("/api/v1/monitors", { method: "POST", ...json({ name: "[smoke] sched", kind: "tcp", target: "127.0.0.1:9", options: { schedule: "Sunday mornings" } }) });
    assert(bad.res.status === 400, `schedule: ${bad.res.status}`);
    const hls = await session("/api/v1/monitors", { method: "POST", ...json({ name: "[smoke] hls", kind: "hls", target: "stream.local" }) });
    assert(hls.res.status === 400, `hls target: ${hls.res.status}`);
  });

  await test("monitors: an Authorization header is never returned, and survives an edit that leaves it out", async () => {
    const made = await session("/api/v1/monitors", {
      method: "POST",
      ...json({ name: "[smoke] secret header", kind: "http", target: "http://127.0.0.1:9/", enabled: false, options: { authorization: "Bearer smoke-secret-value" } }),
    });
    const text = await made.res.text();
    assert(made.res.status === 201 || made.res.status === 200, `create ${made.res.status}`);
    const m = JSON.parse(text);
    try {
      assert(!text.includes("smoke-secret-value") && m.options.authorization === "[saved]", `create reply: ${text}`);
      const edited = await session(`/api/v1/monitors/${m.id}`, { method: "PATCH", ...json({ options: { method: "GET" } }) });
      const after = await edited.res.text();
      assert(edited.res.status === 200 && !after.includes("smoke-secret-value"), `edit reply: ${after}`);
      assert(JSON.parse(after).options.authorization === "[saved]", "the header was dropped by an edit that left it out");
    } finally {
      await session(`/api/v1/monitors/${m.id}`, { method: "DELETE" });
    }
  });
}
