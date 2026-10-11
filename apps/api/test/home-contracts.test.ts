import { describe, expect, it } from "vitest";
import {
  DASHBOARD_LOOKS,
  KNOWN_SETTINGS,
  LOOK_IDS,
  PERMISSIONS,
  dashboardPrefsSchema,
  homeQuerySchema,
  homeSnapshotSchema,
  resolveLook,
  sectionOk,
  updateDashboardPrefsSchema,
  validateSettingValue,
} from "@church/shared";
import type { HomeContext } from "../src/dashboard/home/home.types";
import { HomeService, dayPartIn, firstNameOf } from "../src/dashboard/home/home.service";
import type { AuthenticatedUser } from "../src/auth/current-user.decorator";
import type { SettingsService } from "../src/settings/settings.service";

const ALL = [...LOOK_IDS];
const MON = [PERMISSIONS.MONITORS_READ_ANY];

describe("resolveLook", () => {
  it("prefers url, then device, then user, then site", () => {
    const base = { enabled: ALL, permissions: MON };
    expect(
      resolveLook({ ...base, urlParam: "nave", deviceCookie: "glass", userPref: "start", siteDefault: "tiles" }),
    ).toEqual({ look: "nave", source: "url" });
    expect(resolveLook({ ...base, deviceCookie: "glass", userPref: "start", siteDefault: "tiles" })).toEqual({
      look: "glass",
      source: "device",
    });
    expect(resolveLook({ ...base, userPref: "start", siteDefault: "tiles" })).toEqual({ look: "start", source: "user" });
    expect(resolveLook({ ...base, siteDefault: "tiles" })).toEqual({ look: "tiles", source: "site" });
  });

  it("skips unknown ids, disabled looks and looks the person lacks permission for", () => {
    expect(resolveLook({ urlParam: "bogus", userPref: "nave", enabled: ALL, permissions: [] }).source).toBe("user");
    expect(resolveLook({ urlParam: "nave", siteDefault: "tiles", enabled: ["tiles"], permissions: [] })).toEqual({
      look: "tiles",
      source: "site",
    });
    expect(resolveLook({ urlParam: "glass", siteDefault: "tiles", enabled: ALL, permissions: [] })).toEqual({
      look: "tiles",
      source: "site",
    });
    expect(resolveLook({ urlParam: "front-of-house", enabled: ALL, permissions: MON })).toEqual({
      look: "front-of-house",
      source: "url",
    });
  });

  it("falls back to start even when start is not enabled", () => {
    expect(resolveLook({ enabled: [], permissions: [] })).toEqual({ look: "start", source: "fallback" });
    expect(resolveLook({ urlParam: "glass", siteDefault: "glass", enabled: ["glass"], permissions: [] })).toEqual({
      look: "start",
      source: "fallback",
    });
  });
});

describe("look catalogue and settings", () => {
  it("lists every look id once, with thumbnails and includes", () => {
    expect(DASHBOARD_LOOKS.map((l) => l.id)).toEqual(ALL);
    expect(DASHBOARD_LOOKS.find((l) => l.id === "glass")?.includes).toEqual(["availability"]);
    expect(DASHBOARD_LOOKS.find((l) => l.id === "toward-sunday")?.includes).toEqual(["week", "readiness"]);
    expect(DASHBOARD_LOOKS.find((l) => l.id === "nave")?.thumbnails.dark).toBe("/home-looks/nave-dark.png");
  });

  it("registers the new settings and validates them", () => {
    for (const k of ["site.timezone", "dashboard.default_theme", "dashboard.enabled_themes", "dashboard.stream_monitor_ids"]) {
      expect(KNOWN_SETTINGS.some((s) => s.key === k)).toBe(true);
    }
    expect(validateSettingValue("site.timezone", "Europe/London")).toBeNull();
    expect(validateSettingValue("site.timezone", "Mars/Olympus")).not.toBeNull();
    expect(validateSettingValue("dashboard.default_theme", "glass")).toBeNull();
    expect(validateSettingValue("dashboard.default_theme", "neon")).not.toBeNull();
    expect(validateSettingValue("dashboard.enabled_themes", ["tiles", "start"])).toBeNull();
    expect(validateSettingValue("dashboard.enabled_themes", ["tiles", "neon"])).not.toBeNull();
    expect(validateSettingValue("dashboard.stream_monitor_ids", [])).toBeNull();
    expect(validateSettingValue("site.name", 5)).toBeNull();
  });
});

describe("homeQuerySchema", () => {
  it("parses a comma list, ignores blanks and duplicates", () => {
    expect(homeQuerySchema.parse({}).include).toEqual([]);
    expect(homeQuerySchema.parse({ include: "week,meters" }).include).toEqual(["week", "meters"]);
    expect(homeQuerySchema.parse({ include: "week, week,," }).include).toEqual(["week"]);
  });
  it("rejects unknown values", () => {
    expect(homeQuerySchema.safeParse({ include: "week,nope" }).success).toBe(false);
  });
});

describe("dashboard prefs schemas", () => {
  it("accepts a theme and section ids", () => {
    expect(dashboardPrefsSchema.safeParse({ theme: null, sections: {} }).success).toBe(true);
    expect(dashboardPrefsSchema.safeParse({ theme: "nave", sections: { nave: ["a", "b"] } }).success).toBe(true);
  });
  it("rejects unknown looks and oversized section lists", () => {
    expect(dashboardPrefsSchema.safeParse({ theme: "neon", sections: {} }).success).toBe(false);
    expect(dashboardPrefsSchema.safeParse({ theme: null, sections: { neon: [] } }).success).toBe(false);
    expect(dashboardPrefsSchema.safeParse({ theme: null, sections: { nave: ["x".repeat(65)] } }).success).toBe(false);
    const many = Array.from({ length: 51 }, (_, i) => `s${i}`);
    expect(dashboardPrefsSchema.safeParse({ theme: null, sections: { nave: many } }).success).toBe(false);
  });
  it("update has both fields optional", () => {
    expect(updateDashboardPrefsSchema.safeParse({}).success).toBe(true);
    expect(updateDashboardPrefsSchema.safeParse({ theme: "start" }).success).toBe(true);
  });
});

const user = {
  id: "u1",
  email: "ada.lovelace@example.org",
  name: "Ada Lovelace",
  permissions: [],
  access: {},
} as unknown as AuthenticatedUser;

describe("home helpers", () => {
  it("computes the day part in the site zone", () => {
    const t = new Date("2026-10-10T11:30:00Z");
    expect(dayPartIn(t, "UTC")).toBe("morning");
    expect(dayPartIn(t, "Asia/Tokyo")).toBe("evening");
    expect(dayPartIn(new Date("2026-10-10T14:00:00Z"), "UTC")).toBe("afternoon");
    expect(dayPartIn(new Date("2026-10-10T17:00:00Z"), "UTC")).toBe("evening");
  });
  it("derives a first name", () => {
    expect(firstNameOf(user)).toBe("Ada");
    expect(firstNameOf({ name: null, email: "bob@example.org" })).toBe("bob");
  });
});

describe("HomeService orchestration", () => {
  const settings = {
    get: async (key: string) => ({ "site.timezone": "Europe/London", "site.name": "Grace", "site.tagline": "Come in" })[key],
  } as unknown as SettingsService;

  const off = { build: async () => ({ state: "unavailable" as const, reason: "not built yet" }) };
  const hang = { build: () => new Promise<never>(() => {}) };
  const boom = {
    build: async () => {
      throw new Error("kaboom");
    },
  };
  const ok = { build: async () => sectionOk({ recent: [] }) };

  function make(over: Record<string, unknown> = {}) {
    const p = { service: off, systems: off, tickets: off, checklists: off, wiki: off, notes: off, activity: off, week: off, availability: off, meters: off, needs: off, readiness: off, ...over };
    // Constructor order: settings, service, systems, tickets, checklists, wiki, notes, activity, week, availability, meters, needs, readiness
    const Ctor = HomeService as unknown as new (...a: unknown[]) => HomeService;
    const svc = new Ctor(settings, p.service, p.systems, p.tickets, p.checklists, p.wiki, p.notes, p.activity, p.week, p.availability, p.meters, p.needs, p.readiness);
    svc.sectionTimeoutMs = 50;
    return svc;
  }

  it("returns a valid snapshot with stub sections and no optional sections", async () => {
    const snap = await make().snapshot(user, []);
    expect(homeSnapshotSchema.safeParse(snap).success).toBe(true);
    expect(snap.service).toEqual({ state: "unavailable", reason: "not built yet" });
    expect(snap.user).toEqual({ id: "u1", firstName: "Ada" });
    expect(snap.site).toEqual({ name: "Grace", tagline: "Come in" });
    expect(snap.timezone).toBe("Europe/London");
    expect("week" in snap).toBe(false);
    expect("readiness" in snap).toBe(false);
  });

  it("turns a hanging builder into unavailable within the timeout, leaving others intact", async () => {
    const started = Date.now();
    const snap = await make({ wiki: hang, notes: ok }).snapshot(user, []);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(snap.wiki).toEqual({ state: "unavailable", reason: "timed out" });
    expect(snap.notes).toEqual({ state: "ok", data: { recent: [] } });
  });

  it("turns a throwing builder into unavailable", async () => {
    const snap = await make({ tickets: boom }).snapshot(user, []);
    expect(snap.tickets.state).toBe("unavailable");
  });

  it("builds optional sections only when requested, and passes primaries to derived ones", async () => {
    let seen: unknown;
    const readiness = {
      build: async (_c: HomeContext, primary: unknown) => {
        seen = primary;
        return off.build();
      },
    };
    const snap = await make({ readiness }).snapshot(user, ["week", "readiness"]);
    expect(snap.week?.state).toBe("unavailable");
    expect(snap.readiness?.state).toBe("unavailable");
    expect(snap.availability).toBeUndefined();
    expect(snap.meters).toBeUndefined();
    expect(Object.keys(seen as object).sort()).toEqual(
      ["activity", "checklists", "notes", "service", "systems", "tickets", "wiki"],
    );
  });
});
