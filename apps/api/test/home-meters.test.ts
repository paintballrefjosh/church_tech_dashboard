import { describe, expect, it } from "vitest";
import {
  PERMISSIONS,
  agoText,
  average,
  clampLevel,
  dnsLevel,
  durationText,
  formatLatency,
  formatPercent,
  internetLevel,
  median,
  scaleLevel,
  serversLevel,
  switchesLevel,
  wifiLevel,
} from "@church/shared";
import { HomeMetersSection } from "../src/dashboard/home/sections/meters.section";
import type { HomeContext } from "../src/dashboard/home/home.types";

describe("meter scales", () => {
  it("clamps and refuses unreadable values", () => {
    expect(clampLevel(1.4)).toBe(1);
    expect(clampLevel(-1)).toBe(0);
    expect(clampLevel(Number.NaN)).toBeNull();
    expect(clampLevel(null)).toBeNull();
    expect(scaleLevel(5, 0)).toBeNull();
  });
  it("servers: average CPU / 100", () => {
    expect(serversLevel(23)).toBeCloseTo(0.23);
    expect(serversLevel(null)).toBeNull();
  });
  it("internet: median latency / 200 ms, capped", () => {
    expect(internetLevel(50)).toBeCloseTo(0.25);
    expect(internetLevel(900)).toBe(1);
  });
  it("wifi: clients / 250, capped", () => {
    expect(wifiLevel(125)).toBeCloseTo(0.5);
    expect(wifiLevel(400)).toBe(1);
  });
  it("switches: ports up / known", () => {
    expect(switchesLevel(71, 100)).toBeCloseTo(0.71);
    expect(switchesLevel(0, 0)).toBeNull();
  });
  it("dns: queries per minute / 1000, capped", () => {
    expect(dnsLevel(412)).toBeCloseTo(0.412);
    expect(dnsLevel(5000)).toBe(1);
  });
});

describe("meter helpers", () => {
  it("average and median", () => {
    expect(average([])).toBeNull();
    expect(average([10, 20, 60])).toBe(30);
    expect(median([])).toBeNull();
    expect(median([9, 1, 5])).toBe(5);
    expect(median([1, 2, 3, 10])).toBe(2.5);
  });
  it("formats readings", () => {
    expect(formatPercent(22.6)).toBe("23%");
    expect(formatPercent(null)).toBe("unavailable");
    expect(formatLatency(14.2)).toBe("14 ms");
    expect(formatLatency(3.14)).toBe("3.1 ms");
    expect(formatLatency(null)).toBe("unavailable");
  });
  it("words for time", () => {
    const now = new Date("2026-10-10T12:00:00Z");
    expect(agoText(null, now)).toBe("never");
    expect(agoText(new Date("2026-10-10T11:59:40Z"), now)).toBe("just now");
    expect(agoText(new Date("2026-10-10T11:58:00Z"), now)).toBe("2 min ago");
    expect(agoText(new Date("2026-10-10T09:00:00Z"), now)).toBe("3 h ago");
    expect(durationText(38 * 60_000)).toBe("38 min");
    expect(durationText(30_000)).toBe("30 s");
  });
});

describe("HomeMetersSection", () => {
  const ctx = (permissions: string[]): HomeContext =>
    ({ user: { id: "me", permissions }, now: new Date(), timezone: "UTC", includes: new Set() }) as unknown as HomeContext;

  it("is forbidden without monitors:read:any", async () => {
    const section = new HomeMetersSection({} as never, {} as never, {} as never, {} as never);
    expect((await section.build(ctx([]))).state).toBe("forbidden");
  });

  it("a failing source gives an unavailable channel and the others stand; Wi-Fi is omitted without unifi:read:any", async () => {
    const boom = () => {
      throw new Error("db down");
    };
    const db = { select: boom } as never;
    const dns = { stats: async () => ({ totals: { queries: 6000 } }) } as never;
    const dnsSync = { status: async () => ({ lastRun: null }) } as never;
    const section = new HomeMetersSection(db, {} as never, dns, dnsSync);
    const res = await section.build(ctx([PERMISSIONS.MONITORS_READ_ANY]));
    expect(res.state).toBe("ok");
    if (res.state !== "ok") return;
    const by = Object.fromEntries(res.data.channels.map((c) => [c.area, c]));
    expect(res.data.channels.map((c) => c.area)).toEqual(["servers", "internet", "switches", "dns"]);
    expect(by.servers!.level).toBeNull();
    expect(by.servers!.readings[0]!.value).toBe("unavailable");
    expect(by.dns!.level).toBeCloseTo(0.1);
    expect(by.dns!.readings).toEqual([
      { label: "queries/min", value: "100" },
      { label: "sync", value: "never" },
    ]);
    expect(res.data.recentAlerts).toEqual([]);
  });
});
