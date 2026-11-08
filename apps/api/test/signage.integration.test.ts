import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../src/db/schema";
import { SignageService } from "../src/signage/signage.service";
import { SignageCompiler } from "../src/signage/compiler.service";
import { SignageSetup } from "../src/signage/setup.service";
import { SignageMediaService } from "../src/signage/media.service";
import { DbSearchSources } from "../src/search/search-sources";

/**
 * Signage against a real database (docs/signage.md): content rows and the manifest compiler (a new version only when the
 * content changes, the dirty flag cleared only when nobody marked the screen again meanwhile, at most five kept), what a
 * screen shows and why, and the claims that keep two nodes from running one setup run or converting one file twice.
 * Nothing reaches a Pi: the run's and the file's work are replaced by counters. Run on CockroachDB and YugabyteDB; it
 * empties the signage tables.
 */
const url = process.env.TEST_DATABASE_URL;

const TABLES = [
  "signage_manifests",
  "signage_setup_runs",
  "signage_status_samples",
  "signage_devices",
  "signage_found",
  "signage_overrides",
  "signage_schedules",
  "signage_power_schedules",
  "signage_screen_groups",
  "signage_screenshots",
  "signage_screens",
  "signage_groups",
  "signage_playlist_items",
  "signage_playlists",
  "signage_media",
];

describe.skipIf(!url)("signage against a real database", () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let content: SignageService;
  let compiler: SignageCompiler;
  const q = (text: string, params: unknown[] = []) => pool.query(text, params);
  const jobs = { register: () => undefined };

  beforeAll(async () => {
    process.env.AUTH_SECRET ??= "test-secret-for-signage-integration";
    pool = new Pool({ connectionString: url, max: 6 });
    db = drizzle(pool, { schema });
    const locations = { check: async () => undefined };
    const delivery = { zone: async () => "UTC" };
    content = new SignageService(db as never, locations as never, delivery as never);
    compiler = new SignageCompiler(db as never, jobs as never, content);
  });
  afterAll(async () => {
    await pool?.end();
  });
  beforeEach(async () => {
    for (const t of TABLES) await q(`DELETE FROM ${t}`);
  });

  async function readyImage(name = "Welcome") {
    const r = await q(
      `INSERT INTO signage_media (name, original_name, mime, status, kind, sha256, storage_key, width, height, size_bytes)
       VALUES ($1, $1, 'image/png', 'ready', 'image', $2, $3, 1920, 1080, 1000) RETURNING id`,
      [name, `${name}-sha`.padEnd(64, "0"), `signage/media/${name}.png`],
    );
    return r.rows[0].id as string;
  }

  it("compiles a screen, stores a new version only when its content changes, keeps five", async () => {
    const media = await readyImage();
    const fallback = await content.createPlaylist({ name: "Fallback", description: "", defaultImageDurationS: 8, isAdhoc: false, items: [{ mediaId: media, durationS: 10, enabled: true, validFrom: null, validUntil: null }] }, null);
    const group = await content.createGroup({ name: "Lobby", description: "" });
    const screen = await content.createScreen({ name: "Foyer", locationId: null, orientation: "landscape", tvControl: "none", rokuIp: null, hdmiInput: null, fallbackPlaylistId: fallback.id, groupIds: [group.id], notes: "", enabled: true });
    expect((await content.groupIdsByScreen()).get(screen.id)).toEqual([group.id]);

    const now = new Date("2026-11-08T12:00:00Z");
    await compiler.tick(now);
    const first = await compiler.latestManifest(screen.id);
    expect(first?.manifest.version).toBe(1);
    const row1 = await content.screenRow(screen.id);
    expect(row1.manifestDirtyAt).toBeNull();
    expect(row1.manifestVersion).toBe(1);

    // Marked again with nothing changed: compiled, but the same content keeps the same version.
    await content.markDirty([screen.id]);
    await compiler.tick(now);
    expect((await compiler.latestManifest(screen.id))?.manifest.version).toBe(1);
    expect(Number((await q(`SELECT count(*) AS n FROM signage_manifests WHERE screen_id = $1`, [screen.id])).rows[0].n)).toBe(1);

    // A real change: a new version.
    await content.updatePlaylist(fallback.id, { items: [{ mediaId: media, durationS: 20, enabled: true, validFrom: null, validUntil: null }] });
    await content.markDirty([screen.id]);
    await compiler.tick(now);
    expect((await compiler.latestManifest(screen.id))?.manifest.version).toBe(2);

    // Seven more changes: only the newest five versions are kept.
    for (let i = 0; i < 7; i++) {
      await content.updatePlaylist(fallback.id, { items: [{ mediaId: media, durationS: 30 + i, enabled: true, validFrom: null, validUntil: null }] });
      await content.markDirty([screen.id]);
      await compiler.tick(now);
    }
    const versions = (await q(`SELECT version FROM signage_manifests WHERE screen_id = $1 ORDER BY version`, [screen.id])).rows.map((r) => Number(r.version));
    expect(versions).toEqual([5, 6, 7, 8, 9]);
  });

  it("leaves the dirty flag set when the screen was marked again during a compile", async () => {
    const media = await readyImage();
    const pl = await content.createPlaylist({ name: "P", description: "", defaultImageDurationS: 8, isAdhoc: false, items: [{ mediaId: media, durationS: null, enabled: true, validFrom: null, validUntil: null }] }, null);
    const screen = await content.createScreen({ name: "S", locationId: null, orientation: "landscape", tvControl: "none", rokuIp: null, hdmiInput: null, fallbackPlaylistId: pl.id, groupIds: [], notes: "", enabled: true });
    const before = await content.screenRow(screen.id);
    // Somebody marks it again after the compile read the row.
    await new Promise((r) => setTimeout(r, 5));
    await content.markDirty([screen.id]);
    await compiler.compileScreen(before, [], await compiler.load(), "UTC", new Date());
    expect((await content.screenRow(screen.id)).manifestDirtyAt).not.toBeNull();
  });

  it("an event over a group schedule over the fallback; the preview names every candidate", async () => {
    const media = await readyImage();
    const item = { mediaId: media, durationS: null, enabled: true, validFrom: null, validUntil: null };
    const fb = await content.createPlaylist({ name: "Fallback", description: "", defaultImageDurationS: 8, isAdhoc: false, items: [item] }, null);
    const sched = await content.createPlaylist({ name: "Sunday", description: "", defaultImageDurationS: 8, isAdhoc: false, items: [item] }, null);
    const ev = await content.createPlaylist({ name: "Notice", description: "", defaultImageDurationS: 8, isAdhoc: false, items: [item] }, null);
    const group = await content.createGroup({ name: "All TVs", description: "" });
    const screen = await content.createScreen({ name: "Hall", locationId: null, orientation: "landscape", tvControl: "none", rokuIp: null, hdmiInput: null, fallbackPlaylistId: fb.id, groupIds: [group.id], notes: "", enabled: true });
    await content.createSchedule({ name: "Every day", targetType: "group", targetId: group.id, playlistId: sched.id, priority: 100, daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startTime: "00:00", endTime: "23:59", startDate: null, endDate: null, enabled: true }, null);
    const at = new Date();
    at.setUTCHours(12, 0, 0, 0);
    let pv = await compiler.preview(screen.id, at);
    expect(pv.playlistId).toBe(sched.id);
    const o = await content.createOverride({ name: "Notice", targetType: "all", targetId: null, playlistId: ev.id, startsAt: new Date(at.getTime() - 3600_000).toISOString(), endsAt: new Date(at.getTime() + 3600_000).toISOString(), priority: 100000, forcePowerOn: true }, null);
    expect(o.targetName).toBeTruthy();
    pv = await compiler.preview(screen.id, at);
    expect(pv.playlistId).toBe(ev.id);
    expect(pv.candidates.map((c) => c.playlistName)).toEqual(["Notice", "Sunday", "Fallback"]);
    const listed = await content.listSchedules();
    expect(listed[0]?.targetName).toBe("All TVs");
    // A group still used by a schedule may be deleted only by the rules the service sets; the schedule names it until then.
    const ended = await content.endOverride(o.id);
    expect("state" in ended ? ended.state : "gone").not.toBe("active");
  });

  it("one setup run is claimed by one node, even when two look at once", async () => {
    const dev = await q(`INSERT INTO signage_devices (name, ip, status) VALUES ('Pi', '10.9.9.9', 'active') RETURNING id`);
    await q(`INSERT INTO signage_setup_runs (device_id, ip, kind, status) VALUES ($1, '10.9.9.9', 'apply', 'queued')`, [dev.rows[0].id]);
    const settings = { get: async () => undefined };
    const make = () => new SignageSetup(db as never, jobs as never, settings as never, content, {} as never, {} as never);
    const a = make();
    const b = make();
    const ran = vi.fn(async () => undefined);
    (a as unknown as { execute: typeof ran }).execute = ran;
    (b as unknown as { execute: typeof ran }).execute = ran;
    await Promise.all([a.tick(), b.tick(), a.tick(), b.tick()]);
    expect(ran).toHaveBeenCalledTimes(1);
    const row = (await q(`SELECT status, claimed_until > now() AS held FROM signage_setup_runs`)).rows[0];
    expect(row.status).toBe("running");
    expect(row.held).toBe(true);
  });

  it("a run whose node died (claim lapsed) is taken over, and said to be", async () => {
    await q(`INSERT INTO signage_setup_runs (ip, kind, status, claimed_until, started_at) VALUES ('10.9.9.8', 'setup', 'running', now() - INTERVAL '1 minute', now() - INTERVAL '10 minutes')`);
    const s = new SignageSetup(db as never, jobs as never, { get: async () => undefined } as never, content, {} as never, {} as never);
    const ran = vi.fn(async (_r: unknown, _takenOver?: boolean) => undefined);
    (s as unknown as { execute: typeof ran }).execute = ran;
    await s.tick();
    expect(ran).toHaveBeenCalledTimes(1);
    expect(ran.mock.calls[0]?.[1]).toBe(true);
  });

  it("one uploaded file is converted by one node", async () => {
    await q(`INSERT INTO signage_media (name, original_name, mime, status, upload_key) VALUES ('Up', 'up.png', 'image/png', 'uploaded', 'signage/uploads/x')`);
    const make = () => new SignageMediaService(db as never, jobs as never, content);
    const a = make();
    const b = make();
    const conv = vi.fn(async () => undefined);
    (a as unknown as { convert: typeof conv }).convert = conv;
    (b as unknown as { convert: typeof conv }).convert = conv;
    await Promise.all([a.tick(), b.tick()]);
    expect(conv).toHaveBeenCalledTimes(1);
    expect((await q(`SELECT status FROM signage_media`)).rows[0].status).toBe("processing");
  });

  it("search documents: screens by room, group and notes, playlists by what they play, media; never devices or one-off playlists", async () => {
    const media = await readyImage("Harvest supper");
    const pl = await content.createPlaylist({ name: "Foyer loop", description: "Weekday welcome", defaultImageDurationS: 8, isAdhoc: false, items: [{ mediaId: media, durationS: null, enabled: true, validFrom: null, validUntil: null }] }, null);
    await content.createPlaylist({ name: "One-off", description: "", defaultImageDurationS: 8, isAdhoc: true, items: [] }, null);
    const group = await content.createGroup({ name: "Lobby TVs", description: "" });
    const screen = await content.createScreen({ name: "Foyer", locationId: null, orientation: "landscape", tvControl: "none", rokuIp: null, hdmiInput: null, fallbackPlaylistId: pl.id, groupIds: [group.id], notes: "Above the coat rack", enabled: true });
    await q(`INSERT INTO signage_devices (name, ip, status, screen_id) VALUES ('Pi', '10.9.9.7', 'active', $1)`, [screen.id]);
    const docs = await new DbSearchSources(db as never).loadSignageDocs();
    const byKind = (k: string) => docs.filter((d) => d.kind === k);
    expect(byKind("signage_screen")).toHaveLength(1);
    const s = byKind("signage_screen")[0]!;
    expect(s.url).toBe(`/signage/screens/${screen.id}`);
    expect(s.body).toContain("Lobby TVs");
    expect(s.body).toContain("coat rack");
    expect(JSON.stringify(docs)).not.toContain("10.9.9.7");
    expect(byKind("signage_playlist").map((d) => d.title)).toEqual(["Foyer loop"]);
    expect(byKind("signage_playlist")[0]!.body).toContain("Harvest supper");
    expect(byKind("signage_media").map((d) => d.title)).toEqual(["Harvest supper"]);
  });
});
