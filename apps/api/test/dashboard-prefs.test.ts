import { describe, expect, it } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { DASHBOARD_LOOKS, LOOK_IDS, PERMISSIONS, updateDashboardPrefsSchema } from "@church/shared";
import {
  assertThemeAvailable,
  availableLooks,
  cleanSections,
  normaliseEnabled,
  normaliseSiteDefault,
} from "../src/dashboard/dashboard.service";

describe("dashboard prefs: availability", () => {
  it("hides looks that need monitoring access from people without it", () => {
    const a = availableLooks([...LOOK_IDS], []);
    expect(a).toContain("start");
    expect(a).toContain("nave");
    expect(a).not.toContain("glass");
    expect(a).not.toContain("front-of-house");
  });

  it("offers monitoring looks to people who hold monitors:read:any", () => {
    const a = availableLooks([...LOOK_IDS], [PERMISSIONS.MONITORS_READ_ANY]);
    expect(a).toContain("glass");
    expect(a).toContain("front-of-house");
  });

  it("drops looks the admin switched off, but start is always available", () => {
    expect(availableLooks(["tiles"], [])).toEqual(["tiles", "start"]);
    expect(availableLooks(["glass"], [PERMISSIONS.MONITORS_READ_ANY])).toEqual(["start", "glass"]);
  });
});

describe("dashboard prefs: settings fallbacks", () => {
  it("falls back to tiles for a bad site default", () => {
    expect(normaliseSiteDefault("nope")).toBe("tiles");
    expect(normaliseSiteDefault(undefined)).toBe("tiles");
    expect(normaliseSiteDefault("glass")).toBe("glass");
  });

  it("falls back to every look for a malformed or empty list, ignores unknown ids", () => {
    expect(normaliseEnabled("x")).toEqual([...LOOK_IDS]);
    expect(normaliseEnabled([])).toEqual([...LOOK_IDS]);
    expect(normaliseEnabled(["bogus"])).toEqual([...LOOK_IDS]);
    expect(normaliseEnabled(["start", "bogus", "tiles"])).toEqual(["tiles", "start"]);
  });
});

describe("dashboard prefs: validation", () => {
  it("accepts null (site default) and any available look", () => {
    expect(() => assertThemeAvailable(null, ["start"])).not.toThrow();
    expect(() => assertThemeAvailable(undefined, ["start"])).not.toThrow();
    expect(() => assertThemeAvailable("start", ["start"])).not.toThrow();
  });

  it("rejects a look that is not available", () => {
    expect(() => assertThemeAvailable("glass", ["start"])).toThrow(BadRequestException);
  });

  it("rejects an unknown id at the schema", () => {
    expect(updateDashboardPrefsSchema.safeParse({ theme: "bogus" }).success).toBe(false);
    expect(updateDashboardPrefsSchema.safeParse({ theme: null }).success).toBe(true);
  });
});

describe("dashboard prefs: sections", () => {
  it("keeps known section ids per look and drops unknown ones and repeats", () => {
    expect(cleanSections({ start: ["needs", "bogus", "needs", "recent"] })).toEqual({ start: ["needs", "recent"] });
  });

  it("drops unknown looks, empty lists and malformed values", () => {
    expect(cleanSections({ nope: ["needs"], glass: ["bogus"], nave: "x", tiles: ["needs"] })).toEqual({});
    expect(cleanSections(null)).toEqual({});
    expect(cleanSections([])).toEqual({});
  });

  it("never offers the signature of a look as optional", () => {
    for (const look of DASHBOARD_LOOKS) {
      for (const s of look.optionalSections) expect(s.label).toMatch(/^[A-Z][^.]*$/);
    }
    expect(cleanSections({ nave: ["hero"] })).toEqual({});
  });
});
