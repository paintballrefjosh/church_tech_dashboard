import { describe, expect, it } from "vitest";
import {
  compileManifest,
  compilePlaylist,
  manifestContent,
  manifestEntryAt,
  manifestPowerAt,
  resolveAt,
  weeklyWindows,
  type CompileInput,
  type CompileMedia,
  type CompileOverride,
  type CompileSchedule,
} from "@lampstand/shared";

/** docs/signage.md section 9: the resolution rule, midnight crossings, DST, item windows, empty playlists, power. */

const TZ = "America/Chicago";
const SCREEN = "00000000-0000-4000-8000-000000000001";
const GROUP_A = "00000000-0000-4000-8000-00000000000a";
const GROUP_B = "00000000-0000-4000-8000-00000000000b";

const media: Record<string, CompileMedia> = {
  img1: { id: "img1", sha256: "a".repeat(64), kind: "image", durationS: null, sizeBytes: 1000, status: "ready" },
  img2: { id: "img2", sha256: "b".repeat(64), kind: "image", durationS: null, sizeBytes: 2000, status: "ready" },
  vid: { id: "vid", sha256: "c".repeat(64), kind: "video", durationS: 30, sizeBytes: 9_000_000, status: "ready" },
  busy: { id: "busy", sha256: null, kind: null, durationS: null, sizeBytes: null, status: "processing" },
};

function pl(id: string, mediaIds: string[], extra: Partial<{ validFrom: string; validUntil: string; durationS: number }> = {}) {
  return { id, name: id, defaultImageDurationS: 8, items: mediaIds.map((m) => ({ mediaId: m, durationS: extra.durationS ?? null, enabled: true, validFrom: extra.validFrom ?? null, validUntil: extra.validUntil ?? null })) };
}

function sched(id: string, over: Partial<CompileSchedule>): CompileSchedule {
  return {
    id,
    name: id,
    targetType: "screen",
    targetId: SCREEN,
    playlistId: "p1",
    priority: 100,
    daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
    startTime: "08:00",
    endTime: "12:00",
    startDate: null,
    endDate: null,
    enabled: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

function ov(id: string, over: Partial<CompileOverride>): CompileOverride {
  return {
    id,
    name: id,
    targetType: "screen",
    targetId: SCREEN,
    playlistId: "p2",
    startsAt: new Date("2026-11-08T15:00:00Z"),
    endsAt: new Date("2026-11-08T17:00:00Z"),
    priority: 1000,
    forcePowerOn: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

function input(over: Partial<CompileInput> = {}): CompileInput {
  return {
    screen: { id: SCREEN, name: "Lobby", groupIds: [GROUP_A, GROUP_B], fallbackPlaylistId: "fb", orientation: "landscape", tvControl: "roku_ecp", rokuIp: "10.0.0.5", hdmiInput: "InputHDMI2" },
    playlists: { p1: pl("p1", ["img1", "vid"]), p2: pl("p2", ["img2"]), p3: pl("p3", ["img1"]), fb: pl("fb", ["img2"]), empty: pl("empty", ["busy"]) },
    media,
    schedules: [],
    overrides: [],
    power: [],
    timezone: TZ,
    ...over,
  };
}

// Sunday 8 Nov 2026, 10:00 in Chicago (CST, UTC-6) = 16:00Z.
const SUN_10 = new Date("2026-11-08T16:00:00Z");

describe("signage playlist compile", () => {
  it("uses the video's own length, the playlist's image time, or the item's time", () => {
    const c = compilePlaylist(pl("p1", ["img1", "vid"]), media, "2026-11-08");
    expect(c.items).toEqual([
      { m: "a".repeat(64), dur: 8, kind: "image" },
      { m: "c".repeat(64), dur: 30, kind: "video" },
    ]);
    expect(compilePlaylist(pl("p1", ["vid"], { durationS: 18 }), media, "2026-11-08").items[0]!.dur).toBe(18);
  });

  it("leaves out items outside their dates, switched off or not ready", () => {
    expect(compilePlaylist(pl("x", ["img1"], { validFrom: "2026-11-09" }), media, "2026-11-08").items).toEqual([]);
    expect(compilePlaylist(pl("x", ["img1"], { validUntil: "2026-11-07" }), media, "2026-11-08").items).toEqual([]);
    expect(compilePlaylist(pl("x", ["img1"], { validFrom: "2026-11-08", validUntil: "2026-11-08" }), media, "2026-11-08").items).toHaveLength(1);
    const off = { ...pl("x", ["img1"]), items: [{ mediaId: "img1", durationS: null, enabled: false, validFrom: null, validUntil: null }] };
    expect(compilePlaylist(off, media, "2026-11-08").items).toEqual([]);
    const busy = compilePlaylist(pl("x", ["busy"]), media, "2026-11-08");
    expect(busy.items).toEqual([]);
    expect(busy.skipped).toBe(1);
  });

  it("gives a different key when the items differ and the same key when they do not", () => {
    const a = compilePlaylist(pl("p", ["img1"]), media, "2026-11-08").key;
    expect(compilePlaylist(pl("p", ["img1"]), media, "2026-11-09").key).toBe(a);
    expect(compilePlaylist(pl("p", ["img1", "img2"]), media, "2026-11-08").key).not.toBe(a);
  });
});

describe("signage resolution order", () => {
  it("an event beats a schedule, a screen schedule beats a group schedule, and the fallback fills the rest", () => {
    const base = input({ schedules: [sched("s-screen", { playlistId: "p1" }), sched("s-group", { targetType: "group", targetId: GROUP_A, playlistId: "p3", priority: 500 })] });
    expect(resolveAt(base, SUN_10).winner?.source).toBe("schedule:s-screen");
    expect(resolveAt({ ...base, overrides: [ov("e1", { targetType: "all", targetId: null })] }, SUN_10).winner?.source).toBe("override:e1");
    expect(resolveAt({ ...base, schedules: [base.schedules[1]!] }, SUN_10).winner?.source).toBe("group-schedule:s-group");
    // 13:00 local: no schedule is on.
    expect(resolveAt(base, new Date("2026-11-08T19:00:00Z")).winner?.source).toBe("fallback");
    expect(resolveAt({ ...base, screen: { ...base.screen, fallbackPlaylistId: null } }, new Date("2026-11-08T19:00:00Z")).winner).toBeNull();
  });

  it("orders events by priority first, then the most specific target, then the newest", () => {
    const later = new Date("2026-06-01T00:00:00Z");
    const evs = [
      ov("screen-low", { priority: 10, playlistId: "p1" }),
      ov("all-high", { targetType: "all", targetId: null, priority: 5000, playlistId: "p2" }),
      ov("group-same", { targetType: "group", targetId: GROUP_A, priority: 5000, playlistId: "p3" }),
    ];
    expect(resolveAt(input({ overrides: evs }), SUN_10).winner?.source).toBe("override:group-same");
    const tie = [ov("old", { playlistId: "p1" }), ov("new", { playlistId: "p2", createdAt: later })];
    expect(resolveAt(input({ overrides: tie }), SUN_10).winner?.source).toBe("override:new");
  });

  it("ignores rules for other screens and groups the screen is not in", () => {
    const other = "00000000-0000-4000-8000-0000000000ff";
    const r = resolveAt(input({ schedules: [sched("x", { targetId: other }), sched("y", { targetType: "group", targetId: other })], overrides: [ov("z", { targetType: "group", targetId: other })] }), SUN_10);
    expect(r.winner?.source).toBe("fallback");
  });

  it("falls through a playlist with nothing to play and says why", () => {
    const r = resolveAt(input({ schedules: [sched("s1", { playlistId: "empty", priority: 900 }), sched("s2", { playlistId: "p1" })] }), SUN_10);
    expect(r.winner?.source).toBe("schedule:s2");
    expect(r.candidates[0]).toMatchObject({ source: "schedule:s1", empty: "none of its items are ready yet" });
  });

  it("breaks a group-schedule tie by group id and warns", () => {
    const a = sched("a", { targetType: "group", targetId: GROUP_B, playlistId: "p1" });
    const b = sched("b", { targetType: "group", targetId: GROUP_A, playlistId: "p2" });
    const inp = input({ schedules: [a, b] });
    expect(resolveAt(inp, SUN_10).winner?.source).toBe("group-schedule:b");
    const { warnings } = compileManifest(inp, { from: new Date("2026-11-08T06:00:00Z"), version: 1, days: 1 });
    expect(warnings.join(" ")).toContain("same priority");
  });
});

describe("signage weekly windows", () => {
  it("handles a window that crosses midnight, on the day it starts", () => {
    const ivs = weeklyWindows({ daysOfWeek: [6], start: "22:00", end: "02:00", startDate: null, endDate: null }, new Date("2026-11-06T06:00:00Z"), new Date("2026-11-10T06:00:00Z"), TZ);
    // Saturday 7 Nov 22:00 CST to Sunday 8 Nov 02:00 CST.
    expect(ivs).toEqual([{ start: Date.parse("2026-11-08T04:00:00Z"), end: Date.parse("2026-11-08T08:00:00Z") }]);
  });

  it("keeps wall-clock times across the autumn and spring changes", () => {
    // 1 Nov 2026 is the autumn change in the US (CDT -> CST).
    const fall = weeklyWindows({ daysOfWeek: [6, 7, 1], start: "09:00", end: "10:00", startDate: null, endDate: null }, new Date("2026-10-31T05:00:00Z"), new Date("2026-11-03T06:00:00Z"), TZ);
    expect(fall.map((i) => new Date(i.start).toISOString())).toEqual(["2026-10-31T14:00:00.000Z", "2026-11-01T15:00:00.000Z", "2026-11-02T15:00:00.000Z"]);
    // 14 Mar 2027: CST -> CDT.
    const spring = weeklyWindows({ daysOfWeek: [6, 7], start: "09:00", end: "10:00", startDate: null, endDate: null }, new Date("2027-03-13T06:00:00Z"), new Date("2027-03-15T05:00:00Z"), TZ);
    expect(spring.map((i) => new Date(i.start).toISOString())).toEqual(["2027-03-13T15:00:00.000Z", "2027-03-14T14:00:00.000Z"]);
  });

  it("is a 25-hour day across the autumn change for an all-night window", () => {
    const [iv] = weeklyWindows({ daysOfWeek: [6], start: "12:00", end: "12:00", startDate: null, endDate: null }, new Date("2026-10-31T05:00:00Z"), new Date("2026-11-02T06:00:00Z"), TZ);
    expect((iv!.end - iv!.start) / 3_600_000).toBe(25);
  });

  it("respects the first and last day", () => {
    const ivs = weeklyWindows({ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], start: "09:00", end: "10:00", startDate: "2026-11-09", endDate: "2026-11-10" }, new Date("2026-11-08T06:00:00Z"), new Date("2026-11-15T06:00:00Z"), TZ);
    expect(ivs).toHaveLength(2);
  });
});

describe("signage manifest", () => {
  const from = new Date("2026-11-08T06:00:00Z"); // Sunday 00:00 CST

  it("builds a contiguous, non-overlapping timeline with the fallback between schedules", () => {
    const { manifest } = compileManifest(input({ schedules: [sched("s", { daysOfWeek: [7] })] }), { from, version: 3, days: 1 });
    const t = manifest.timeline;
    expect(t.map((e) => e.source)).toEqual(["fallback", "schedule:s", "fallback"]);
    for (let i = 1; i < t.length; i++) expect(t[i]!.start).toBe(t[i - 1]!.end);
    expect(t[0]!.start).toBe(from.toISOString());
    expect(t[t.length - 1]!.end).toBe(manifest.validUntil);
    expect(manifest.timeline[1]).toMatchObject({ start: "2026-11-08T14:00:00.000Z", end: "2026-11-08T18:00:00.000Z" });
    expect(manifestEntryAt(manifest, SUN_10)?.source).toBe("schedule:s");
  });

  it("lists every file used in the window with its size", () => {
    const { manifest } = compileManifest(input({ schedules: [sched("s", {})] }), { from, version: 1 });
    expect(Object.keys(manifest.media).sort()).toEqual(["a".repeat(64), "b".repeat(64), "c".repeat(64)]);
    expect(manifest.media["c".repeat(64)]).toEqual({ kind: "video", bytes: 9_000_000 });
    expect(manifest.fallbackPlaylist).toMatch(/^fb~/);
    expect(manifest.validUntil).toBe("2026-11-22T06:00:00.000Z");
  });

  it("drops an announcement on its last day without anyone touching it", () => {
    const inp = input({ playlists: { ...input().playlists, p1: pl("p1", ["img1"], { validUntil: "2026-11-08" }) }, schedules: [sched("s", {})] });
    const { manifest } = compileManifest(inp, { from, version: 1, days: 2 });
    const sundayEntry = manifest.timeline.find((e) => e.start === "2026-11-08T14:00:00.000Z");
    expect(sundayEntry?.source).toBe("schedule:s");
    const mondayEntry = manifest.timeline.find((e) => e.start <= "2026-11-09T15:00:00.000Z" && e.end > "2026-11-09T15:00:00.000Z");
    expect(mondayEntry?.source).toBe("fallback");
  });

  it("does not change its content when nothing changed", () => {
    const a = compileManifest(input({ schedules: [sched("s", {})] }), { from, version: 1, generatedAt: new Date(1) }).manifest;
    const b = compileManifest(input({ schedules: [sched("s", {})] }), { from, version: 2, generatedAt: new Date(2) }).manifest;
    expect(manifestContent(a)).toBe(manifestContent(b));
  });

  it("only manages power when a power schedule applies, and an event can force the TV on", () => {
    expect(compileManifest(input(), { from, version: 1, days: 1 }).manifest.powerInitial).toBeNull();
    const power = [{ id: "pw", name: "pw", targetType: "all" as const, targetId: null, daysOfWeek: [7], onTime: "07:45", offTime: "13:15", startDate: null, endDate: null, enabled: true }];
    const m = compileManifest(input({ power }), { from, version: 1, days: 1 }).manifest;
    expect(m.powerInitial).toBe("off");
    expect(m.power).toEqual([
      { at: "2026-11-08T13:45:00.000Z", state: "on" },
      { at: "2026-11-08T19:15:00.000Z", state: "off" },
    ]);
    expect(manifestPowerAt(m, SUN_10)).toBe("on");
    expect(manifestPowerAt(m, new Date("2026-11-08T20:00:00Z"))).toBe("off");
    const forced = compileManifest(input({ power, overrides: [ov("late", { startsAt: new Date("2026-11-09T01:00:00Z"), endsAt: new Date("2026-11-09T02:00:00Z"), forcePowerOn: true })] }), { from, version: 1, days: 1 }).manifest;
    expect(manifestPowerAt(forced, new Date("2026-11-09T01:30:00Z"))).toBe("on");
    expect(resolveAt(input({ power }), SUN_10).power).toBe("on");
  });

  it("tells the Pi the TV settings, with the Roku address only for a Roku TV", () => {
    expect(compileManifest(input(), { from, version: 1, days: 1 }).manifest.tv).toEqual({ control: "roku_ecp", rokuIp: "10.0.0.5", input: "InputHDMI2" });
    const cec = input();
    cec.screen = { ...cec.screen, tvControl: "cec" };
    expect(compileManifest(cec, { from, version: 1, days: 1 }).manifest.tv.rokuIp).toBeNull();
  });
});
