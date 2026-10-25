/**
 * Cabinet smoke tests, run from run.mjs: creating a cabinet, placing items (overlaps and out-of-range refused, a device only
 * once), moving and removing them, and the data behind the printable port sheets. Read-only against every device: only
 * cabinets are created, and each one made here is deleted before the block ends.
 */
export async function cabinetTests({ test, assert, fetchWithCookies, jar }) {
  const json = (body) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const admin = (path, init = {}) => fetchWithCookies(path, init, jar);
  const made = [];

  async function makeRack(extra = {}) {
    const { res } = await admin("/api/v1/racks", { method: "POST", ...json({ name: `[smoke] cabinet ${Date.now()}-${made.length}`, units: 12, ...extra }) });
    const text = await res.text();
    assert(res.status === 200 || res.status === 201, `create status ${res.status}: ${text}`);
    const rack = JSON.parse(text);
    made.push(rack.id);
    return rack;
  }
  const addItem = (rackId, body) => admin(`/api/v1/racks/${rackId}/items`, { method: "POST", ...json(body) });

  try {
    await test("cabinets: need a session", async () => {
      const { res } = await fetchWithCookies("/api/v1/racks");
      assert(res.status === 401, `status ${res.status}`);
    });

    let rack;
    await test("cabinets: create one, refuse a duplicate name and a silly height", async () => {
      rack = await makeRack();
      assert(rack.units === 12 && rack.name.startsWith("[smoke]"), `rack: ${JSON.stringify(rack)}`);
      const dup = await admin("/api/v1/racks", { method: "POST", ...json({ name: rack.name.toUpperCase(), units: 12 }) });
      assert(dup.res.status === 409, `duplicate gave ${dup.res.status}`);
      const tall = await admin("/api/v1/racks", { method: "POST", ...json({ name: "[smoke] too tall", units: 500 }) });
      assert(tall.res.status === 400, `500U gave ${tall.res.status}`);
      const list = await admin("/api/v1/racks").then(({ res }) => res.json());
      const mine = list.find((r) => r.id === rack.id);
      assert(mine && mine.itemCount === 0 && mine.usedUnits === 0, `list entry: ${JSON.stringify(mine)}`);
    });

    let panel;
    await test("cabinets: place a custom item; overlaps and items past the top are refused", async () => {
      const { res } = await addItem(rack.id, { sourceKind: "custom", label: "Patch panel A", style: "patch_panel", startU: 10, heightU: 2, ip: "10.9.9.9" });
      assert(res.status === 200 || res.status === 201, `place status ${res.status}`);
      panel = await res.json();
      assert(panel.live.name === "Patch panel A" && panel.live.ip === "10.9.9.9" && panel.live.missing === false, `item: ${JSON.stringify(panel)}`);
      for (const [startU, heightU] of [[11, 1], [9, 2], [12, 2], [13, 1]]) {
        const bad = await addItem(rack.id, { sourceKind: "custom", label: "clash", startU, heightU });
        assert(bad.res.status === 409, `U${startU} x${heightU} gave ${bad.res.status}`);
      }
      const ok = await addItem(rack.id, { sourceKind: "custom", label: "Shelf", style: "shelf", startU: 9, heightU: 1 });
      assert(ok.res.status === 200 || ok.res.status === 201, `adjacent place status ${ok.res.status}`);
      const noName = await addItem(rack.id, { sourceKind: "custom", startU: 1, heightU: 1 });
      assert(noName.res.status === 400, `no name gave ${noName.res.status}`);
    });

    await test("cabinets: moving an item checks the new place; the cabinet cannot shrink under an item", async () => {
      const clash = await admin(`/api/v1/racks/${rack.id}/items/${panel.id}`, { method: "PATCH", ...json({ startU: 9 }) });
      assert(clash.res.status === 409, `move onto the shelf gave ${clash.res.status}`);
      const moved = await admin(`/api/v1/racks/${rack.id}/items/${panel.id}`, { method: "PATCH", ...json({ startU: 5, label: "Patch panel B" }) });
      assert(moved.res.status === 200, `move status ${moved.res.status}`);
      const body = await moved.res.json();
      assert(body.startU === 5 && body.live.name === "Patch panel B", `moved: ${JSON.stringify(body)}`);
      const shrink = await admin(`/api/v1/racks/${rack.id}`, { method: "PATCH", ...json({ units: 8 }) });
      assert(shrink.res.status === 409, `shrinking under the shelf gave ${shrink.res.status}`);
      const fine = await admin(`/api/v1/racks/${rack.id}`, { method: "PATCH", ...json({ units: 9 }) });
      assert(fine.res.status === 200, `shrinking to the shelf gave ${fine.res.status}`);
    });

    await test("cabinets: a Cisco switch or infrastructure host is placed once, with its own name and address", async () => {
      const candidates = await admin("/api/v1/racks/candidates").then(({ res }) => (res.status === 200 ? res.json() : []));
      assert(Array.isArray(candidates), "candidates should be a list");
      const linked = candidates.filter((c) => c.kind !== "unifi" && c.placedIn === null);
      if (linked.length === 0) return; // nothing on this stack to place
      const dev = linked[0];
      const first = await addItem(rack.id, { sourceKind: dev.kind, sourceId: dev.id, startU: 1, heightU: 1 });
      assert(first.res.status === 200 || first.res.status === 201, `place status ${first.res.status}`);
      const item = await first.res.json();
      assert(item.live.name === dev.name && item.live.missing === false, `item: ${JSON.stringify(item.live)} vs ${dev.name}`);
      assert(item.live.href && item.live.href.startsWith("/monitoring/"), `href ${item.live.href}`);
      const twice = await addItem(rack.id, { sourceKind: dev.kind, sourceId: dev.id, startU: 2, heightU: 1 });
      assert(twice.res.status === 409, `second placement gave ${twice.res.status}`);
      const again = await admin("/api/v1/racks/candidates").then(({ res }) => res.json());
      assert(again.find((c) => c.kind === dev.kind && c.id === dev.id)?.placedIn?.rackId === rack.id, "the candidate list should say where it sits");
      // A linked item's name belongs to the device: an edit cannot rename it.
      const rename = await admin(`/api/v1/racks/${rack.id}/items/${item.id}`, { method: "PATCH", ...json({ label: "renamed" }) });
      assert(rename.res.status === 200 && (await rename.res.json()).live.name === dev.name, "a linked item should keep the device's name");
    });

    await test("cabinets: a device that does not exist cannot be placed", async () => {
      const { res } = await addItem(rack.id, { sourceKind: "cisco", sourceId: "00000000-0000-4000-8000-000000000000", startU: 3, heightU: 1 });
      assert(res.status === 400, `status ${res.status}`);
    });

    await test("cabinets: taking an item out leaves the device alone; deleting the cabinet takes its items", async () => {
      const del = await admin(`/api/v1/racks/${rack.id}/items/${panel.id}`, { method: "DELETE" });
      assert(del.res.status === 200, `remove status ${del.res.status}`);
      const gone = await admin(`/api/v1/racks/${rack.id}/items/${panel.id}`, { method: "DELETE" });
      assert(gone.res.status === 404, `second remove gave ${gone.res.status}`);
      const detail = await admin(`/api/v1/racks/${rack.id}`).then(({ res }) => res.json());
      assert(!detail.items.some((i) => i.id === panel.id), "the item should be gone");
      const all = await admin(`/api/v1/racks/${rack.id}`, { method: "DELETE" });
      assert(all.res.status === 200, `delete status ${all.res.status}`);
      made.splice(made.indexOf(rack.id), 1);
      const after = await admin(`/api/v1/racks/${rack.id}`);
      assert(after.res.status === 404, `deleted cabinet gave ${after.res.status}`);
    });

    await test("port sheets: a Cisco switch lists every port with a VLAN and a subnet column", async () => {
      const switches = await admin("/api/v1/cisco/switches").then(({ res }) => (res.status === 200 ? res.json() : []));
      if (switches.length === 0) return;
      const sw = switches.find((s) => (s.portCount ?? 1) > 0) ?? switches[0];
      const { res } = await admin(`/api/v1/port-sheets/cisco/${sw.id}`);
      assert(res.status === 200, `status ${res.status}`);
      const sheet = await res.json();
      assert(sheet.kind === "cisco" && sheet.device.name === sw.hostname, `device: ${JSON.stringify(sheet.device)}`);
      assert(Array.isArray(sheet.ports) && Array.isArray(sheet.notes), "shape");
      for (const p of sheet.ports) {
        assert(typeof p.port === "string" && typeof p.vlan === "string" && typeof p.subnet === "string" && typeof p.description === "string", `row ${JSON.stringify(p)}`);
      }
      const missing = await admin("/api/v1/port-sheets/cisco/00000000-0000-4000-8000-000000000000");
      assert(missing.res.status === 404, `unknown switch gave ${missing.res.status}`);
    });

    await test("port sheets: a UniFi sheet needs a real MAC; a switch the controller lists gives its ports", async () => {
      const bad = await admin("/api/v1/port-sheets/unifi/not-a-mac");
      assert(bad.res.status === 400, `bad MAC gave ${bad.res.status}`);
      const devices = await admin("/api/v1/unifi/devices").then(({ res }) => (res.status === 200 ? res.json() : []));
      const sw = devices.find((d) => d.mac && Array.isArray(d.port_table) && d.port_table.length > 0);
      if (!sw) return; // no UniFi switch reachable from this stack
      const { res } = await admin(`/api/v1/port-sheets/unifi/${encodeURIComponent(sw.mac)}`);
      assert(res.status === 200, `status ${res.status}`);
      const sheet = await res.json();
      assert(sheet.kind === "unifi" && sheet.ports.length > 0, `sheet: ${JSON.stringify(sheet).slice(0, 200)}`);
      assert(sheet.ports.every((p) => typeof p.vlan === "string" && typeof p.subnet === "string"), "every row needs a vlan and subnet string");
    });
  } finally {
    for (const id of made) await admin(`/api/v1/racks/${id}`, { method: "DELETE" }).catch(() => undefined);
  }
}
