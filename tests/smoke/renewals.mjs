/** Renewals smoke tests, run from run.mjs. Everything made here is deleted before the block ends. */
export async function renewalTests({ test, assert, fetchWithCookies, jar }) {
  const json = (body) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const session = (path, init = {}) => fetchWithCookies(path, init, jar);
  const made = [];
  try {
    await test("renewals: need a session; a date that does not exist is refused", async () => {
      assert((await fetchWithCookies("/api/v1/renewals")).res.status === 401, "no session");
      const bad = await session("/api/v1/renewals", { method: "POST", ...json({ name: "[smoke] bad date", renewsOn: "2026-02-30" }) });
      assert(bad.res.status === 400, `impossible date: ${bad.res.status}`);
    });

    await test("renewals: create, list in date order, edit, and the default reminders", async () => {
      const later = await session("/api/v1/renewals", { method: "POST", ...json({ name: "[smoke] later", renewsOn: "2099-12-31", cost: 120 }) });
      const sooner = await session("/api/v1/renewals", { method: "POST", ...json({ name: "[smoke] sooner", renewsOn: "2099-01-01", category: "domain", vendor: "Registrar" }) });
      for (const r of [later, sooner]) assert(r.res.status === 201 || r.res.status === 200, `create ${r.res.status}`);
      const a = await later.res.json();
      const b = await sooner.res.json();
      made.push(a.id, b.id);
      assert(JSON.stringify(a.remindDays) === JSON.stringify([30, 7]), `default reminders: ${JSON.stringify(a.remindDays)}`);
      const list = await (await session("/api/v1/renewals")).res.json();
      const mine = list.filter((r) => r.name.startsWith("[smoke]")).map((r) => r.name);
      assert(mine.indexOf("[smoke] sooner") < mine.indexOf("[smoke] later"), `order: ${mine}`);
      const edited = await session(`/api/v1/renewals/${a.id}`, { method: "PATCH", ...json({ autoRenew: true, remindDays: [60, 14, 60] }) });
      assert(edited.res.status === 200, `patch ${edited.res.status}`);
      const after = await edited.res.json();
      assert(after.autoRenew === true && JSON.stringify(after.remindDays) === JSON.stringify([60, 14]), JSON.stringify(after));
    });
  } finally {
    for (const id of made) await session(`/api/v1/renewals/${id}`, { method: "DELETE" }).catch(() => undefined);
  }
}
