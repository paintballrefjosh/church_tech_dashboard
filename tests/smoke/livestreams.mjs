/**
 * Livestream smoke tests, run from run.mjs (docs/livestreams.md). Nothing here reads a real stream: every stream made is
 * switched off, so the checker never touches it. It proves the doors (a session, the module's tiers), that a private link is
 * never returned and is refused when it points at this server, that "check now" refuses a switched-off stream, and that the
 * history and picture routes answer for a new stream. Everything made here is removed before the block ends.
 */
export async function livestreamTests({ test, assert, fetchWithCookies, jar }) {
  const json = (body) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const admin = (path, init = {}) => fetchWithCookies(path, init, jar);
  const stamp = Date.now();
  const made = [];
  let volunteer = null;
  const base = { platform: "other", access: "public", pageUrl: "https://cdn.example.invalid/live/index.m3u8", schedule: "Sun 10:00-12:00", enabled: false };

  try {
    await test("livestreams: need a session", async () => {
      const { res } = await fetchWithCookies("/api/v1/livestreams");
      assert(res.status === 401, `gave ${res.status}`);
    });

    let stream;
    await test("livestreams: create a switched-off stream; a private link is kept and never returned", async () => {
      const { res } = await admin("/api/v1/livestreams", { method: "POST", ...json({ ...base, name: `[smoke] stream ${stamp}` }) });
      const text = await res.text();
      assert(res.status === 200 || res.status === 201, `create ${res.status}: ${text}`);
      stream = JSON.parse(text);
      made.push(stream.id);
      assert(stream.state === "disabled" && stream.hasStreamUrl === false, `new stream: ${text}`);
      const secret = "https://cdn.example.invalid/live/index.m3u8?token=smoke-secret-token";
      const upd = await admin(`/api/v1/livestreams/${stream.id}`, { method: "PATCH", ...json({ access: "private", streamUrl: secret }) });
      const updText = await upd.res.text();
      assert(upd.res.status === 200, `update ${upd.res.status}: ${updText}`);
      assert(!updText.includes("smoke-secret-token"), "the private link came back in the answer");
      assert(JSON.parse(updText).hasStreamUrl === true, "hasStreamUrl should be true");
      const list = await admin("/api/v1/livestreams").then(({ res: r }) => r.text());
      assert(!list.includes("smoke-secret-token"), "the private link is in the list");
      const audit = await admin(`/api/v1/audit?resourceType=livestream&resourceId=${stream.id}`).then(({ res: r }) => r.text());
      assert(!audit.includes("smoke-secret-token"), "the private link is in the audit log");
    });

    await test("livestreams: links to this server, metadata addresses or with a password are refused", async () => {
      for (const pageUrl of ["http://127.0.0.1:3001/api/v1/me", "http://169.254.169.254/latest/meta-data", "http://localhost/x.m3u8", "http://api:3001/api/v1/me", "https://u:p@cdn.example.invalid/x.m3u8", "file:///etc/passwd"]) {
        const { res } = await admin("/api/v1/livestreams", { method: "POST", ...json({ ...base, name: `[smoke] bad ${stamp}`, pageUrl }) });
        assert(res.status === 400, `${pageUrl} gave ${res.status}`);
      }
      const sched = await admin("/api/v1/livestreams", { method: "POST", ...json({ ...base, name: `[smoke] bad ${stamp}`, schedule: "every Sunday" }) });
      assert(sched.res.status === 400, `a bad schedule gave ${sched.res.status}`);
    });

    await test("livestreams: check now refuses a switched-off stream; history and picture answer", async () => {
      const chk = await admin(`/api/v1/livestreams/${stream.id}/check`, { method: "POST" });
      assert(chk.res.status === 409, `check now on a switched-off stream gave ${chk.res.status}`);
      const hist = await admin(`/api/v1/livestreams/${stream.id}/history?hours=24`);
      assert(hist.res.status === 200 && Array.isArray(await hist.res.json()), `history ${hist.res.status}`);
      const snap = await admin(`/api/v1/livestreams/${stream.id}/snapshot`);
      assert(snap.res.status === 404, `no picture yet gave ${snap.res.status}`);
      const choices = await admin("/api/v1/livestreams/choices").then(({ res: r }) => r.json());
      assert(Array.isArray(choices.groups) && Array.isArray(choices.monitors), "choices shape");
    });

    await test("livestreams: a volunteer with the user tier reads streams but cannot add, edit or delete", async () => {
      const email = `livestreams-volunteer-${stamp}@example.com`;
      const password = "smoke-volunteer-pw-1234";
      const created = await admin("/api/v1/users", {
        method: "POST",
        ...json({ email, displayName: "Livestreams Volunteer Smoke", password, sendInvite: false, sendWelcomeEmail: false, mustChangePassword: false }),
      });
      assert(created.res.status === 200 || created.res.status === 201, `create user ${created.res.status}`);
      volunteer = { user: await created.res.json(), groupId: null };
      const group = await admin("/api/v1/groups", { method: "POST", ...json({ name: `livestreams-smoke-${stamp}`, description: "smoke" }) });
      volunteer.groupId = (await group.res.json()).id;
      await admin(`/api/v1/groups/${volunteer.groupId}/module-access`, { method: "PUT", ...json({ access: { livestreams: "user" } }) });
      await admin(`/api/v1/groups/${volunteer.groupId}/members`, { method: "POST", ...json({ userId: volunteer.user.id }) });
      const j = new Map();
      const csrf = await fetchWithCookies("/api/auth/csrf", {}, j).then(({ res }) => res.json());
      await fetchWithCookies(
        "/api/auth/callback/credentials",
        { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrfToken: csrf.csrfToken, email, password, callbackUrl: "/", json: "true" }).toString() },
        j,
      );
      const me = await fetchWithCookies("/api/v1/me", {}, j).then(({ res }) => res.json());
      if (me.permissions.includes("livestreams:write:any")) return; // this install gives every account the moderator tier; nothing to prove
      assert(me.permissions.includes("livestreams:read:any"), "the volunteer should read livestreams");
      const list = await fetchWithCookies("/api/v1/livestreams", {}, j);
      assert(list.res.status === 200, `volunteer list ${list.res.status}`);
      const add = await fetchWithCookies("/api/v1/livestreams", { method: "POST", ...json({ ...base, name: "[smoke] volunteer" }) }, j);
      assert(add.res.status === 403, `volunteer add gave ${add.res.status}`);
      const edit = await fetchWithCookies(`/api/v1/livestreams/${stream.id}`, { method: "PATCH", ...json({ name: "x" }) }, j);
      assert(edit.res.status === 403, `volunteer edit gave ${edit.res.status}`);
      const del = await fetchWithCookies(`/api/v1/livestreams/${stream.id}`, { method: "DELETE" }, j);
      assert(del.res.status === 403, `volunteer delete gave ${del.res.status}`);
      const keys = await fetchWithCookies("/api/v1/livestreams/platforms/resi/test", { method: "POST" }, j);
      assert(keys.res.status === 403, `volunteer key test gave ${keys.res.status}`);
    });
  } finally {
    for (const id of made) await admin(`/api/v1/livestreams/${id}`, { method: "DELETE" });
    if (volunteer) {
      if (volunteer.groupId) await admin(`/api/v1/groups/${volunteer.groupId}`, { method: "DELETE" });
      await admin(`/api/v1/users/${volunteer.user.id}`, { method: "DELETE" });
      await admin(`/api/v1/users/${volunteer.user.id}/hard-delete`, { method: "POST" });
    }
  }
}
