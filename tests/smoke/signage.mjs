/**
 * Signage smoke tests, run from run.mjs (docs/signage.md). Nothing here reaches a Pi or a TV: no device is set up, no
 * address is scanned or knocked on, and the one screen made has no TV control. It proves the doors (a session, the
 * module's tiers, settings only for the Signage admin), media upload and conversion (a small PNG made here), playlists,
 * a schedule and an event deciding what a screen shows (preview, timeline, manifest), power times, refused input
 * (a subnet wider than /22, a bad security setting, an event that ends before it starts) and that the dashboard's key
 * is a public key only. Everything made here is removed before the block ends.
 */
import { deflateSync } from "node:zlib";

/** CRC-32 as PNG wants it (zlib.crc32 is Node 22+; the smoke image is Node 20). */
function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** A plain PNG of `w` x `h` in one colour: enough for the converter to make a picture and a thumbnail. */
function png(w, h, [r, g, b]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

export async function signageTests({ test, assert, fetchWithCookies, jar }) {
  const json = (body) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const admin = (path, init = {}) => fetchWithCookies(path, init, jar);
  const stamp = Date.now();
  const made = { events: [], power: [], schedules: [], playlists: [], screens: [], groups: [], media: [], subnets: [] };
  let volunteer = null;

  const me = await admin("/api/v1/me").then(({ res }) => res.json());
  if (!me.permissions?.includes("signage:admin")) {
    await test("signage: the regression account is not a Signage admin here; skipped", async () => {});
    return;
  }

  try {
    await test("signage: needs a session", async () => {
      for (const p of ["/api/v1/signage/screens", "/api/v1/signage/devices", "/api/v1/signage/summary"]) {
        const { res } = await fetchWithCookies(p);
        assert(res.status === 401, `${p} gave ${res.status}`);
      }
    });

    let media;
    await test("signage: a picture is uploaded and converted, with a thumbnail", async () => {
      const fd = new FormData();
      fd.append("file", new Blob([png(320, 180, [20, 90, 160])], { type: "image/png" }), `[smoke] blue ${stamp}.png`);
      const { res } = await admin("/api/v1/signage/media", { method: "POST", body: fd });
      const text = await res.text();
      assert(res.status === 202, `upload ${res.status}: ${text}`);
      media = JSON.parse(text);
      made.media.push(media.id);
      const until = Date.now() + 60_000;
      while (Date.now() < until && (media.status === "uploaded" || media.status === "processing")) {
        await new Promise((r) => setTimeout(r, 1000));
        media = await admin(`/api/v1/signage/media/${media.id}`).then(({ res: r }) => r.json());
      }
      assert(media.status === "ready" && media.kind === "image", `media ${media.status}: ${media.error}`);
      const thumb = await admin(`/api/v1/signage/media/${media.id}/thumb`);
      assert(thumb.res.status === 200 && /^image\//.test(thumb.res.headers.get("content-type") ?? ""), `thumb ${thumb.res.status}`);
    });

    await test("signage: an empty upload is refused and not kept", async () => {
      const before = (await admin("/api/v1/signage/media").then(({ res }) => res.json())).length;
      const fd = new FormData();
      fd.append("file", new Blob([new Uint8Array(0)], { type: "image/png" }), "[smoke] empty.png");
      const { res } = await admin("/api/v1/signage/media", { method: "POST", body: fd });
      assert(res.status === 409 || res.status === 400, `empty upload gave ${res.status}`);
      const after = (await admin("/api/v1/signage/media").then(({ res: r }) => r.json())).length;
      assert(after === before, `an empty upload left a row (${before} -> ${after})`);
    });

    let group, screen, weekday, evening;
    await test("signage: a screen in a group, two playlists, a schedule; the preview says why", async () => {
      group = await admin("/api/v1/signage/groups", { method: "POST", ...json({ name: `[smoke] group ${stamp}` }) }).then(({ res }) => res.json());
      made.groups.push(group.id);
      weekday = await admin("/api/v1/signage/playlists", { method: "POST", ...json({ name: `[smoke] fallback ${stamp}`, items: [{ mediaId: media.id, durationS: 10 }] }) }).then(({ res }) => res.json());
      made.playlists.push(weekday.id);
      evening = await admin("/api/v1/signage/playlists", { method: "POST", ...json({ name: `[smoke] scheduled ${stamp}`, items: [{ mediaId: media.id }] }) }).then(({ res }) => res.json());
      made.playlists.push(evening.id);
      assert(weekday.loopSeconds === 10 && evening.loopSeconds === evening.defaultImageDurationS, `loops ${weekday.loopSeconds} ${evening.loopSeconds}`);
      const s = await admin("/api/v1/signage/screens", { method: "POST", ...json({ name: `[smoke] screen ${stamp}`, fallbackPlaylistId: weekday.id, groupIds: [group.id] }) });
      const text = await s.res.text();
      assert(s.res.status === 200 || s.res.status === 201, `screen ${s.res.status}: ${text}`);
      screen = JSON.parse(text);
      made.screens.push(screen.id);
      assert(screen.device === null && screen.tvControl === "none", "a new screen has no device and no TV control");
      const sch = await admin("/api/v1/signage/schedules", {
        method: "POST",
        ...json({ name: `[smoke] schedule ${stamp}`, targetType: "group", targetId: group.id, playlistId: evening.id, daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startTime: "00:00", endTime: "23:59" }),
      });
      const schText = await sch.res.text();
      assert(sch.res.status === 200 || sch.res.status === 201, `schedule ${sch.res.status}: ${schText}`);
      made.schedules.push(JSON.parse(schText).id);
      const pv = await admin(`/api/v1/signage/screens/${screen.id}/preview`).then(({ res }) => res.json());
      assert(Array.isArray(pv.candidates) && typeof pv.why === "string" && pv.why.length > 0, `preview: ${JSON.stringify(pv)}`);
      assert(pv.candidates.some((c) => c.playlistName === weekday.name), "the fallback is not among the candidates");
      const tl = await admin(`/api/v1/signage/screens/${screen.id}/timeline`);
      const tlBody = await tl.res.json();
      assert(tl.res.status === 200 && Array.isArray(tlBody.entries) && tlBody.entries.some((e) => e.playlistId === evening.id), `timeline ${tl.res.status}: ${JSON.stringify(tlBody).slice(0, 300)}`);
      const mf = await admin(`/api/v1/signage/screens/${screen.id}/manifest`);
      assert(mf.res.status === 200, `manifest ${mf.res.status}`);
    });

    await test("search: a screen is found by its group's name, a playlist by its own, each linking to its page", async () => {
      const find = async (q, kind, id) => {
        for (let i = 0; i < 20; i++) {
          const { res } = await admin(`/api/v1/search?q=${encodeURIComponent(q)}&kind=${kind}`);
          if (res.status !== 200) return undefined; // search not configured here
          const hit = (await res.json()).hits.find((h) => h.resourceId === id);
          if (hit) return hit;
          await new Promise((r) => setTimeout(r, 500));
        }
        return null;
      };
      const s = await find(`group ${stamp}`, "signage_screen", screen.id);
      if (s === undefined) return;
      assert(s && s.url === `/signage/screens/${screen.id}`, `screen hit: ${JSON.stringify(s)}`);
      const p = await find(`fallback ${stamp}`, "signage_playlist", weekday.id);
      assert(p && p.url === `/signage/playlists/${weekday.id}`, `playlist hit: ${JSON.stringify(p)}`);
    });

    await test("signage: an event over the schedule wins, then ends now", async () => {
      const startsAt = new Date(Date.now() - 60_000).toISOString();
      const endsAt = new Date(Date.now() + 3600_000).toISOString();
      const bad = await admin("/api/v1/signage/events", { method: "POST", ...json({ name: "[smoke] backwards", targetType: "screen", targetId: screen.id, playlistId: evening.id, startsAt: endsAt, endsAt: startsAt }) });
      assert(bad.res.status === 400, `an event that ends before it starts gave ${bad.res.status}`);
      const noTarget = await admin("/api/v1/signage/events", { method: "POST", ...json({ name: "[smoke] no target", targetType: "screen", targetId: null, playlistId: evening.id, startsAt, endsAt }) });
      assert(noTarget.res.status === 400, `an event with no screen gave ${noTarget.res.status}`);
      const ev = await admin("/api/v1/signage/events", { method: "POST", ...json({ name: `[smoke] event ${stamp}`, targetType: "screen", targetId: screen.id, playlistId: weekday.id, startsAt, endsAt, priority: 5000 }) }).then(({ res }) => res.json());
      made.events.push(ev.id);
      assert(ev.state === "active", `event state ${ev.state}`);
      const pv = await admin(`/api/v1/signage/screens/${screen.id}/preview`).then(({ res }) => res.json());
      assert(pv.playlistId === weekday.id, `the event did not win: ${JSON.stringify(pv)}`);
      const ended = await admin(`/api/v1/signage/events/${ev.id}/end`, { method: "POST" }).then(({ res }) => res.json());
      assert(ended.state === "ended", `after End now: ${ended.state}`);
    });

    await test("signage: power times; a playlist in use cannot lose its media", async () => {
      const p = await admin("/api/v1/signage/power", { method: "POST", ...json({ name: `[smoke] power ${stamp}`, targetType: "screen", targetId: screen.id, daysOfWeek: [7], onTime: "08:00", offTime: "13:00" }) });
      const text = await p.res.text();
      assert(p.res.status === 200 || p.res.status === 201, `power ${p.res.status}: ${text}`);
      made.power.push(JSON.parse(text).id);
      const same = await admin("/api/v1/signage/power", { method: "POST", ...json({ name: "[smoke] same", targetType: "all", targetId: null, daysOfWeek: [1], onTime: "08:00", offTime: "08:00" }) });
      assert(same.res.status === 400, `equal on/off times gave ${same.res.status}`);
      const del = await admin(`/api/v1/signage/media/${media.id}`, { method: "DELETE" });
      assert(del.res.status === 409, `deleting media a playlist uses gave ${del.res.status}`);
    });

    await test("signage: discovery refuses a subnet wider than /22; a listed one is not scanned by itself", async () => {
      const wide = await admin("/api/v1/signage/discovery/subnets", { method: "POST", ...json({ cidr: "10.0.0.0/16" }) });
      assert(wide.res.status === 400, `a /16 gave ${wide.res.status}`);
      const pub = await admin("/api/v1/signage/discovery/subnets", { method: "POST", ...json({ cidr: "203.0.113.0/28" }) });
      assert(pub.res.status === 400, `a public subnet gave ${pub.res.status}`);
      // Continuous is off and Scan now is never pressed, so nothing knocks on it.
      const s = await admin("/api/v1/signage/discovery/subnets", { method: "POST", ...json({ cidr: "10.255.254.0/28", continuous: false, label: `[smoke] ${stamp}` }) }).then(({ res }) => res.json());
      made.subnets.push(s.id);
      assert(s.continuous === false && s.lastRunAt === null, `subnet: ${JSON.stringify(s)}`);
      const found = await admin("/api/v1/signage/discovery/found");
      assert(found.res.status === 200 && Array.isArray(await found.res.json()), `found ${found.res.status}`);
      const setup = await admin("/api/v1/signage/setup", { method: "POST", ...json({ foundId: "00000000-0000-4000-8000-000000000000" }) });
      assert(setup.res.status === 404, `setup of an unknown Pi gave ${setup.res.status}`);
    });

    await test("signage: the key route shows a public key only; settings refuse a bad value", async () => {
      const key = await admin("/api/v1/signage/key").then(({ res }) => res.text());
      assert(/"publicKey":"ssh-ed25519 /.test(key), `key: ${key.slice(0, 200)}`);
      assert(!/PRIVATE KEY|"privateKey"/.test(key), "the private key came back");
      const bad = await admin("/api/v1/settings/signage.ssh_from", { method: "PUT", ...json({ value: "not a subnet" }) });
      assert(bad.res.status === 400, `a bad source list gave ${bad.res.status}`);
      const summary = await admin("/api/v1/signage/summary").then(({ res }) => res.json());
      assert(typeof summary.devices === "number" && typeof summary.attention === "number", `summary: ${JSON.stringify(summary)}`);
    });

    await test("signage: a volunteer with the user tier reads screens but cannot change them, see devices or settings", async () => {
      const email = `signage-volunteer-${stamp}@example.com`;
      const password = "smoke-volunteer-pw-1234";
      const created = await admin("/api/v1/users", {
        method: "POST",
        ...json({ email, displayName: "Signage Volunteer Smoke", password, sendInvite: false, sendWelcomeEmail: false, mustChangePassword: false }),
      });
      assert(created.res.status === 200 || created.res.status === 201, `create user ${created.res.status}`);
      volunteer = { user: await created.res.json(), groupId: null };
      const g = await admin("/api/v1/groups", { method: "POST", ...json({ name: `signage-smoke-${stamp}`, description: "smoke" }) });
      volunteer.groupId = (await g.res.json()).id;
      await admin(`/api/v1/groups/${volunteer.groupId}/module-access`, { method: "PUT", ...json({ access: { signage: "user" } }) });
      await admin(`/api/v1/groups/${volunteer.groupId}/members`, { method: "POST", ...json({ userId: volunteer.user.id }) });
      const j = new Map();
      const csrf = await fetchWithCookies("/api/auth/csrf", {}, j).then(({ res }) => res.json());
      await fetchWithCookies(
        "/api/auth/callback/credentials",
        { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrfToken: csrf.csrfToken, email, password, callbackUrl: "/", json: "true" }).toString() },
        j,
      );
      const vme = await fetchWithCookies("/api/v1/me", {}, j).then(({ res }) => res.json());
      if (vme.permissions.includes("signage:write:any")) return; // this install gives every account more than the user tier
      assert(vme.permissions.includes("signage:read:any"), "the volunteer should read signage");
      const list = await fetchWithCookies("/api/v1/signage/screens", {}, j);
      assert(list.res.status === 200, `volunteer screens ${list.res.status}`);
      const edit = await fetchWithCookies(`/api/v1/signage/screens/${screen.id}`, { method: "PATCH", ...json({ name: "x" }) }, j);
      assert(edit.res.status === 403, `volunteer edit gave ${edit.res.status}`);
      const devices = await fetchWithCookies("/api/v1/signage/devices", {}, j);
      assert(devices.res.status === 403, `volunteer devices gave ${devices.res.status}`);
      const key = await fetchWithCookies("/api/v1/signage/key", {}, j);
      assert(key.res.status === 403, `volunteer key gave ${key.res.status}`);
      const setting = await fetchWithCookies("/api/v1/settings/signage.ssh_password_login", { method: "PUT", ...json({ value: true }) }, j);
      assert(setting.res.status === 403, `volunteer setting gave ${setting.res.status}`);
      const all = await fetchWithCookies("/api/v1/settings", {}, j).then(({ res }) => res.json());
      assert(!JSON.stringify(all).includes("signage.setup_password"), "a volunteer can see the setup password setting");
    });
  } finally {
    for (const id of made.events) await admin(`/api/v1/signage/events/${id}`, { method: "DELETE" });
    for (const id of made.power) await admin(`/api/v1/signage/power/${id}`, { method: "DELETE" });
    for (const id of made.schedules) await admin(`/api/v1/signage/schedules/${id}`, { method: "DELETE" });
    for (const id of made.screens) await admin(`/api/v1/signage/screens/${id}`, { method: "DELETE" });
    for (const id of made.groups) await admin(`/api/v1/signage/groups/${id}`, { method: "DELETE" });
    for (const id of made.playlists) await admin(`/api/v1/signage/playlists/${id}`, { method: "DELETE" });
    for (const id of made.media) await admin(`/api/v1/signage/media/${id}`, { method: "DELETE" });
    for (const id of made.subnets) await admin(`/api/v1/signage/discovery/subnets/${id}`, { method: "DELETE" });
    if (volunteer) {
      if (volunteer.groupId) await admin(`/api/v1/groups/${volunteer.groupId}`, { method: "DELETE" });
      await admin(`/api/v1/users/${volunteer.user.id}`, { method: "DELETE" });
      await admin(`/api/v1/users/${volunteer.user.id}/hard-delete`, { method: "POST" });
    }
  }
}
