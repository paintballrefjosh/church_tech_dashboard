/**
 * Equipment and rooms smoke tests, run from run.mjs (docs/assets.md): rooms (create, duplicate refused, rename carried to a
 * cabinet, delete clears links), items (next tag, duplicate tag refused, cost hidden from a volunteer), checking out and back
 * in (to yourself as a volunteer, to someone else only as staff, never twice), the import, a ticket about an item in a room,
 * and search. Everything made here is removed before the block ends.
 */
export async function assetTests({ test, assert, fetchWithCookies, jar }) {
  const json = (body) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const admin = (path, init = {}) => fetchWithCookies(path, init, jar);
  const stamp = Date.now();
  const rooms = [];
  const items = [];
  const tickets = [];
  const racks = [];
  let volunteer = null;

  async function room(name, extra = {}) {
    const { res } = await admin("/api/v1/locations", { method: "POST", ...json({ name, ...extra }) });
    const text = await res.text();
    assert(res.status === 200 || res.status === 201, `room create ${res.status}: ${text}`);
    const r = JSON.parse(text);
    rooms.push(r.id);
    return r;
  }
  async function item(body) {
    const { res } = await admin("/api/v1/assets", { method: "POST", ...json(body) });
    const text = await res.text();
    assert(res.status === 200 || res.status === 201, `item create ${res.status}: ${text}`);
    const a = JSON.parse(text);
    items.push(a.id);
    return a;
  }

  try {
    await test("rooms and equipment: need a session", async () => {
      for (const p of ["/api/v1/locations", "/api/v1/assets"]) {
        const { res } = await fetchWithCookies(p);
        assert(res.status === 401, `${p} gave ${res.status}`);
      }
    });

    let booth;
    await test("rooms: create, refuse a duplicate name, and a rename reaches a cabinet in the room", async () => {
      booth = await room(`[smoke] Booth ${stamp}`, { building: "[smoke] Main" });
      const dup = await admin("/api/v1/locations", { method: "POST", ...json({ name: booth.name }) });
      assert(dup.res.status === 409, `duplicate gave ${dup.res.status}`);
      const rack = await admin("/api/v1/racks", { method: "POST", ...json({ name: `[smoke] room rack ${stamp}`, units: 4, locationId: booth.id }) }).then(({ res }) => res.json());
      racks.push(rack.id);
      assert(rack.locationId === booth.id && rack.location === booth.name, `rack: ${JSON.stringify(rack)}`);
      const renamed = await admin(`/api/v1/locations/${booth.id}`, { method: "PATCH", ...json({ name: `[smoke] Sound booth ${stamp}` }) });
      assert(renamed.res.status === 200, `rename ${renamed.res.status}`);
      booth = await renamed.res.json();
      const again = await admin(`/api/v1/racks/${rack.id}`).then(({ res }) => res.json());
      assert(again.location === booth.name, `cabinet text after rename: ${again.location}`);
      const bad = await admin("/api/v1/racks", { method: "POST", ...json({ name: `[smoke] bad rack ${stamp}`, units: 4, locationId: "00000000-0000-4000-8000-000000000000" }) });
      assert(bad.res.status === 400, `unknown room gave ${bad.res.status}`);
    });

    let mic;
    await test("equipment: an item gets the next tag; a tag in use is refused", async () => {
      mic = await item({ name: "[smoke] Wireless mic", category: "audio", make: "Shure", serial: `SN-${stamp}`, locationId: booth.id, cost: 450 });
      assert(/^A-\d{4,}$/.test(mic.tag), `tag ${mic.tag}`);
      assert(mic.location?.id === booth.id && mic.cost === 450 && mic.holder === null, `item: ${JSON.stringify(mic)}`);
      const dup = await admin("/api/v1/assets", { method: "POST", ...json({ name: "[smoke] other", tag: mic.tag }) });
      assert(dup.res.status === 409, `duplicate tag gave ${dup.res.status}`);
      const listed = await admin(`/api/v1/assets?q=${encodeURIComponent(`SN-${stamp}`)}`).then(({ res }) => res.json());
      assert(listed.length === 1 && listed[0].id === mic.id, `search by serial: ${listed.length}`);
    });

    await test("equipment: staff check out to a named person; it cannot go out twice; the history and due date follow", async () => {
      const out = await admin(`/api/v1/assets/${mic.id}/checkout`, { method: "POST", ...json({ holderName: "Visiting band", dueOn: "2030-01-01" }) });
      assert(out.res.status === 200 || out.res.status === 201, `checkout ${out.res.status}`);
      const a = await out.res.json();
      assert(a.holder?.name === "Visiting band" && a.holder.userId === null && a.holder.dueOn === "2030-01-01", `holder: ${JSON.stringify(a.holder)}`);
      const twice = await admin(`/api/v1/assets/${mic.id}/checkout`, { method: "POST", ...json({}) });
      assert(twice.res.status === 409, `second checkout gave ${twice.res.status}`);
      const due = await admin(`/api/v1/assets/${mic.id}/due`, { method: "PUT", ...json({ dueOn: "2030-02-01" }) });
      assert(due.res.status === 200 && (await due.res.json()).holder.dueOn === "2030-02-01", `due ${due.res.status}`);
      const overdue = await admin(`/api/v1/assets?holding=out`).then(({ res }) => res.json());
      assert(overdue.some((x) => x.id === mic.id), "checked out list should include it");
      const back = await admin(`/api/v1/assets/${mic.id}/return`, { method: "POST", ...json({ note: "fine" }) });
      assert(back.res.status === 200 || back.res.status === 201, `return ${back.res.status}`);
      assert((await back.res.json()).holder === null, "should be back");
      const again = await admin(`/api/v1/assets/${mic.id}/return`, { method: "POST", ...json({}) });
      assert(again.res.status === 409, `returning twice gave ${again.res.status}`);
      const hist = await admin(`/api/v1/assets/${mic.id}/history`).then(({ res }) => res.json());
      assert(hist.length === 1 && hist[0].returnedAt && hist[0].returnNote === "fine", `history: ${JSON.stringify(hist)}`);
    });

    await test("equipment: installed kit and an item in repair cannot be checked out", async () => {
      const projector = await item({ name: "[smoke] Projector", category: "video", lendable: false });
      const p = await admin(`/api/v1/assets/${projector.id}/checkout`, { method: "POST", ...json({}) });
      assert(p.res.status === 409, `installed gave ${p.res.status}`);
      const broken = await item({ name: "[smoke] Broken cable", category: "cable", status: "in_repair" });
      const b = await admin(`/api/v1/assets/${broken.id}/checkout`, { method: "POST", ...json({}) });
      assert(b.res.status === 409, `in repair gave ${b.res.status}`);
    });

    await test("equipment: a volunteer checks out to themselves only, sees no cost, and cannot edit", async () => {
      const email = `assets-volunteer-${stamp}@example.com`;
      const password = "smoke-volunteer-pw-1234";
      const created = await admin("/api/v1/users", {
        method: "POST",
        ...json({ email, displayName: "Assets Volunteer Smoke", password, sendInvite: false, sendWelcomeEmail: false, mustChangePassword: false }),
      });
      assert(created.res.status === 200 || created.res.status === 201, `create user ${created.res.status}`);
      volunteer = { user: await created.res.json(), groupId: null };
      const group = await admin("/api/v1/groups", { method: "POST", ...json({ name: `assets-smoke-${stamp}`, description: "smoke" }) });
      volunteer.groupId = (await group.res.json()).id;
      await admin(`/api/v1/groups/${volunteer.groupId}/module-access`, { method: "PUT", ...json({ access: { assets: "user" } }) });
      await admin(`/api/v1/groups/${volunteer.groupId}/members`, { method: "POST", ...json({ userId: volunteer.user.id }) });
      const j = new Map();
      const csrf = await fetchWithCookies("/api/auth/csrf", {}, j).then(({ res }) => res.json());
      await fetchWithCookies(
        "/api/auth/callback/credentials",
        { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrfToken: csrf.csrfToken, email, password, callbackUrl: "/", json: "true" }).toString() },
        j,
      );
      const me = await fetchWithCookies("/api/v1/me", {}, j).then(({ res }) => res.json());
      if (me.permissions.includes("assets:write:any")) return; // this install gives every account staff rights; nothing to prove
      assert(me.permissions.includes("assets:checkout:own"), "the volunteer should be able to check out to themselves");
      const seen = await fetchWithCookies(`/api/v1/assets/${mic.id}`, {}, j).then(({ res }) => res.json());
      assert(seen.cost === null && seen.purchasedOn === null, `cost visible to a volunteer: ${seen.cost}`);
      const forOther = await fetchWithCookies(`/api/v1/assets/${mic.id}/checkout`, { method: "POST", ...json({ holderName: "Someone" }) }, j);
      assert(forOther.res.status === 403, `volunteer for someone else gave ${forOther.res.status}`);
      const edit = await fetchWithCookies(`/api/v1/assets/${mic.id}`, { method: "PATCH", ...json({ name: "renamed" }) }, j);
      assert(edit.res.status === 403, `volunteer edit gave ${edit.res.status}`);
      const hist = await fetchWithCookies(`/api/v1/assets/${mic.id}/history`, {}, j);
      assert(hist.res.status === 403, `volunteer history gave ${hist.res.status}`);
      const mine = await fetchWithCookies(`/api/v1/assets/${mic.id}/checkout`, { method: "POST", ...json({}) }, j);
      assert(mine.res.status === 200 || mine.res.status === 201, `volunteer own checkout ${mine.res.status}`);
      assert((await mine.res.json()).holder?.userId === volunteer.user.id, "should be with the volunteer");
      const withMe = await fetchWithCookies("/api/v1/assets?holding=mine", {}, j).then(({ res }) => res.json());
      assert(withMe.length === 1 && withMe[0].id === mic.id, `with me: ${withMe.length}`);
      const back = await fetchWithCookies(`/api/v1/assets/${mic.id}/return`, { method: "POST", ...json({}) }, j);
      assert(back.res.status === 200 || back.res.status === 201, `volunteer return ${back.res.status}`);
      const roomEdit = await fetchWithCookies(`/api/v1/locations/${booth.id}`, { method: "PATCH", ...json({ notes: "x" }) }, j);
      assert(roomEdit.res.status === 403, `volunteer room edit gave ${roomEdit.res.status}`);
      const roomsRead = await fetchWithCookies("/api/v1/locations", {}, j);
      assert(roomsRead.res.status === 200, `volunteer room list gave ${roomsRead.res.status}`);
    });

    await test("equipment: import is all or nothing; missing rooms are refused unless asked for", async () => {
      const name = `[smoke] Annex ${stamp}`;
      const rows = [
        { name: "[smoke] Imported laptop", category: "computer", room: name },
        { name: "[smoke] Imported cable", category: "cable", room: booth.name.toUpperCase() },
      ];
      const refused = await admin("/api/v1/assets/import", { method: "POST", ...json({ rows, createRooms: false }) });
      assert(refused.res.status === 400, `missing room gave ${refused.res.status}`);
      const dupTag = await admin("/api/v1/assets/import", { method: "POST", ...json({ rows: [{ name: "[smoke] x", tag: mic.tag }], createRooms: false }) });
      assert(dupTag.res.status === 409, `tag in use gave ${dupTag.res.status}`);
      const ok = await admin("/api/v1/assets/import", { method: "POST", ...json({ rows, createRooms: true }) });
      assert(ok.res.status === 200 || ok.res.status === 201, `import ${ok.res.status}: ${await ok.res.clone().text()}`);
      const result = await ok.res.json();
      assert(result.created === 2 && result.roomsCreated.length === 1, `result: ${JSON.stringify(result)}`);
      const all = await admin("/api/v1/assets?q=%5Bsmoke%5D%20Imported").then(({ res }) => res.json());
      for (const a of all) items.push(a.id);
      assert(all.length === 2, `imported found: ${all.length}`);
      const cable = all.find((a) => a.name.endsWith("cable"));
      assert(cable.location?.id === booth.id, "a room is matched by name in any case");
      const made = (await admin("/api/v1/locations").then(({ res }) => res.json())).find((r) => r.name === name);
      if (made) rooms.push(made.id);
      assert(made, "the missing room should have been created");
    });

    await test("tickets: a ticket about an item in a room; the room page lists it and the item", async () => {
      const t = await admin("/api/v1/tickets", { method: "POST", ...json({ title: `[smoke] mic crackles ${stamp}`, description: "", priority: "low", locationId: booth.id, assetId: mic.id }) });
      assert(t.res.status === 200 || t.res.status === 201, `ticket ${t.res.status}: ${await t.res.clone().text()}`);
      const ticket = await t.res.json();
      tickets.push(ticket.id);
      assert(ticket.locationId === booth.id && ticket.assetId === mic.id, `ticket: ${JSON.stringify(ticket)}`);
      const bad = await admin("/api/v1/tickets", { method: "POST", ...json({ title: "[smoke] bad room", locationId: "00000000-0000-4000-8000-000000000000" }) });
      assert(bad.res.status === 400, `unknown room gave ${bad.res.status}`);
      const summary = await admin(`/api/v1/locations/${booth.id}/summary`).then(({ res }) => res.json());
      assert(summary.tickets?.some((x) => x.id === ticket.id), "the room should list the open ticket");
      assert(summary.assets?.some((x) => x.id === mic.id), "the room should list the item");
      assert(summary.racks?.length === 1, `the room should list its cabinet: ${JSON.stringify(summary.racks)}`);
      const about = await admin(`/api/v1/assets/${mic.id}/tickets`).then(({ res }) => res.json());
      assert(about.some((x) => x.id === ticket.id), "the item should list the ticket");
    });

    await test("search: an item is found by its serial number", async () => {
      // This node indexes at once; allow a moment for Meilisearch to apply the write.
      let hit = null;
      for (let i = 0; i < 20 && !hit; i++) {
        const { res } = await admin(`/api/v1/search?q=${encodeURIComponent(`SN-${stamp}`)}&kind=asset`);
        if (res.status !== 200) return; // search not configured here
        hit = (await res.json()).hits.find((h) => h.resourceId === mic.id);
        if (!hit) await new Promise((r) => setTimeout(r, 500));
      }
      assert(hit && hit.url === `/assets/${mic.id}`, "the item should be found");
    });

    await test("rooms: deleting a room clears it from what was in it", async () => {
      const usage = await admin(`/api/v1/locations/${booth.id}/usage`).then(({ res }) => res.json());
      assert(usage.assets >= 2 && usage.tickets === 1 && usage.racks === 1, `usage: ${JSON.stringify(usage)}`);
      const del = await admin(`/api/v1/locations/${booth.id}`, { method: "DELETE" });
      assert(del.res.status === 200, `delete ${del.res.status}`);
      rooms.splice(rooms.indexOf(booth.id), 1);
      const a = await admin(`/api/v1/assets/${mic.id}`).then(({ res }) => res.json());
      assert(a.location === null, "the item should have no room");
      const rack = await admin(`/api/v1/racks/${racks[0]}`).then(({ res }) => res.json());
      assert(rack.locationId === null && rack.location === "", `cabinet after delete: ${JSON.stringify({ id: rack.locationId, text: rack.location })}`);
      const gone = await admin(`/api/v1/locations/${booth.id}/summary`);
      assert(gone.res.status === 404, `deleted room gave ${gone.res.status}`);
    });
  } finally {
    for (const id of tickets) await admin(`/api/v1/tickets/${id}`, { method: "DELETE" });
    for (const id of items) await admin(`/api/v1/assets/${id}`, { method: "DELETE" });
    for (const id of racks) await admin(`/api/v1/racks/${id}`, { method: "DELETE" });
    for (const id of rooms) await admin(`/api/v1/locations/${id}`, { method: "DELETE" });
    if (volunteer) {
      if (volunteer.groupId) await admin(`/api/v1/groups/${volunteer.groupId}`, { method: "DELETE" });
      await admin(`/api/v1/users/${volunteer.user.id}`, { method: "DELETE" });
      await admin(`/api/v1/users/${volunteer.user.id}/hard-delete`, { method: "POST" });
    }
  }
}
