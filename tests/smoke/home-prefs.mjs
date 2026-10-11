/**
 * Home page look preferences (GET/PUT /api/v1/dashboard/prefs), run from run.mjs. The test user's
 * saved look is put back to "site default" (theme null) before the block ends.
 */
const ALL_LOOKS = ["tiles", "start", "nave", "toward-sunday", "glass", "front-of-house"];

export async function homePrefsTests({ test, assert, fetchWithCookies, jar }) {
  const json = (method, body) => ({
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const session = (path, init = {}) => fetchWithCookies(path, init, jar);
  const put = (body) => session("/api/v1/dashboard/prefs", json("PUT", body));
  const get = async () => {
    const { res } = await session("/api/v1/dashboard/prefs");
    assert(res.status === 200, `GET prefs status ${res.status}`);
    return res.json();
  };

  await test("home prefs: GET /dashboard/prefs requires a session", async () => {
    const { res } = await fetchWithCookies("/api/v1/dashboard/prefs");
    assert(res.status === 401, `status ${res.status}`);
  });

  let initial;
  await test("home prefs: GET returns the choice, site default, enabled and available looks", async () => {
    initial = await get();
    assert(initial.theme === null || ALL_LOOKS.includes(initial.theme), `theme ${initial.theme}`);
    assert(ALL_LOOKS.includes(initial.siteDefault), `siteDefault ${initial.siteDefault}`);
    assert(Array.isArray(initial.enabled) && initial.enabled.length > 0, "enabled is empty");
    assert(Array.isArray(initial.available), "available is not an array");
    assert(initial.available.includes("start"), "start is always available");
    assert(initial.available.every((l) => ALL_LOOKS.includes(l)), "unknown id in available");
    assert(typeof initial.sections === "object" && initial.sections !== null, "sections missing");
  });

  await test("home prefs: PUT saves an available look and GET returns it", async () => {
    const { res } = await put({ theme: "start" });
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(body.theme === "start", `PUT returned theme ${body.theme}`);
    assert(Array.isArray(body.available), "PUT did not return the GET shape");
    assert((await get()).theme === "start", "GET did not return the saved look");
  });

  await test("home prefs: theme null returns to the site default", async () => {
    const { res } = await put({ theme: null });
    assert(res.status === 200, `status ${res.status}`);
    assert((await res.json()).theme === null, "PUT did not clear the theme");
    assert((await get()).theme === null, "GET still returns a saved look");
  });

  await test("home prefs: an unknown look is a 400", async () => {
    const { res } = await put({ theme: "no-such-look" });
    assert(res.status === 400, `status ${res.status}`);
    const after = await get();
    assert(after.theme === null, "an invalid PUT changed the saved look");
  });

  await test("home prefs: a look this user may not use is a 400", async () => {
    const current = await get();
    const unavailable = ALL_LOOKS.find((l) => !current.available.includes(l));
    if (!unavailable) return; // this user can use every look: nothing to refuse
    const { res } = await put({ theme: unavailable });
    assert(res.status === 400, `status ${res.status} for ${unavailable}`);
    assert((await get()).theme === null, "a refused PUT changed the saved look");
  });

  await test("home prefs: the update is audited against the user", async () => {
    const { res: meRes } = await session("/api/v1/me");
    const me = await meRes.json();
    assert((await put({ theme: "start" })).res.status === 200, "PUT failed");
    await new Promise((r) => setTimeout(r, 400));
    const { res } = await session("/api/v1/audit?action=dashboard.prefs.update&limit=5");
    if (res.status === 403) return; // this user cannot read the audit log
    assert(res.status === 200, `audit status ${res.status}`);
    const body = await res.json();
    assert(
      Array.isArray(body.items) &&
        body.items.some((e) => e.action === "dashboard.prefs.update" && e.resourceId === me.id),
      "no dashboard.prefs.update audit entry for this user",
    );
  });

  await test("home prefs: reset the test user to the site default", async () => {
    const { res } = await put({ theme: null });
    assert(res.status === 200, `status ${res.status}`);
    assert((await get()).theme === null, "still has a saved look");
  });
}
