/**
 * Home snapshot smoke tests (GET /api/v1/dashboard/home), run from run.mjs. Read-only: nothing is
 * created except a short-lived, read-only, notes-only API token (to see the "forbidden" shape),
 * which is revoked before the block ends.
 */
const PRIMARY = ["service", "systems", "needs", "tickets", "checklists", "wiki", "notes", "activity"];
const STATES = ["ok", "unconfigured", "unavailable", "forbidden"];

export async function homeSnapshotTests({ test, assert, fetchWithCookies, jar }) {
  const session = (path, init = {}) => fetchWithCookies(path, init, jar);
  const bearer = (token, path) =>
    fetchWithCookies(path, { headers: { authorization: `Bearer ${token}` } }, new Map());

  function checkShape(snap) {
    assert(typeof snap.generatedAt === "string" && !Number.isNaN(Date.parse(snap.generatedAt)), "generatedAt");
    assert(typeof snap.timezone === "string" && snap.timezone.length > 0, "timezone");
    assert(["morning", "afternoon", "evening"].includes(snap.dayPart), `dayPart ${snap.dayPart}`);
    assert(snap.user && typeof snap.user.id === "string" && typeof snap.user.firstName === "string", "user");
    assert(snap.site && typeof snap.site.name === "string" && typeof snap.site.tagline === "string", "site");
    for (const key of PRIMARY) {
      const s = snap[key];
      assert(s && STATES.includes(s.state), `${key}: bad state ${JSON.stringify(s)?.slice(0, 120)}`);
      if (s.state === "ok") assert("data" in s, `${key}: ok without data`);
    }
  }

  await test("home snapshot: every primary section is present with a valid state", async () => {
    const { res } = await session("/api/v1/dashboard/home");
    assert(res.status === 200, `status ${res.status}`);
    const snap = await res.json();
    checkShape(snap);
    for (const optional of ["week", "readiness", "availability", "meters"]) {
      assert(!(optional in snap), `${optional} appeared without being requested`);
    }
    if (snap.systems.state === "ok") {
      const d = snap.systems.data;
      assert(Array.isArray(d.areas) && d.areas.length === 5, "systems: five areas");
      assert(Array.isArray(d.problems), "systems: problems");
      assert(typeof d.maintenanceMode === "boolean" && typeof d.canWrite === "boolean", "systems: flags");
    }
    if (snap.tickets.state === "ok") {
      const t = snap.tickets.data;
      assert(Array.isArray(t.mine) && t.mine.length <= 10, "tickets: mine");
      assert(typeof t.openCount === "number" && typeof t.unassignedCount === "number", "tickets: counts");
    }
    if (snap.needs.state === "ok") {
      assert(Array.isArray(snap.needs.data), "needs is a list");
      for (const n of snap.needs.data) assert(typeof n.href === "string" && n.href.startsWith("/"), `need href ${n.href}`);
    }
  });

  await test("home snapshot: answers quickly on a second call (cached sources)", async () => {
    await session("/api/v1/dashboard/home");
    const started = Date.now();
    const { res } = await session("/api/v1/dashboard/home");
    assert(res.status === 200, `status ${res.status}`);
    const ms = Date.now() - started;
    assert(ms < 3000, `second call took ${ms} ms`);
  });

  await test("home snapshot: a bad include is a 400", async () => {
    const { res } = await session("/api/v1/dashboard/home?include=nope");
    assert(res.status === 400, `status ${res.status}`);
  });

  await test("home snapshot: a section the caller cannot see is forbidden (notes-only token)", async () => {
    const created = await session("/api/v1/me/api-tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "smoke home snapshot", modules: ["notes"], expiresInDays: 1 }),
    });
    assert(created.res.status === 201 || created.res.status === 200, `token status ${created.res.status}`);
    const token = await created.res.json();
    try {
      const { res } = await bearer(token.token, "/api/v1/dashboard/home");
      assert(res.status === 200, `status ${res.status}`);
      const snap = await res.json();
      checkShape(snap);
      assert(snap.systems.state === "forbidden", `systems ${snap.systems.state}`);
      assert(snap.tickets.state === "forbidden", `tickets ${snap.tickets.state}`);
      assert(snap.service.state === "forbidden", `service ${snap.service.state}`);
      assert(snap.notes.state === "ok", `notes ${snap.notes.state}`);
      if (snap.needs.state === "ok") {
        assert(!snap.needs.data.some((n) => n.source === "system"), "monitoring needs leaked to a notes-only token");
      }
    } finally {
      await session(`/api/v1/me/api-tokens/${token.id}`, { method: "DELETE" });
    }
  });
}
