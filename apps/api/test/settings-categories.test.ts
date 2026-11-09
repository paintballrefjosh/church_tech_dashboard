import { describe, expect, it } from "vitest";
import { ALERT_KEYS, KNOWN_SETTINGS, PERMISSIONS, SETTING_CATEGORY_MANAGE_PERMISSION, TOGGLE_PREREQUISITES } from "@lampstand/shared";

const categoryOf = (key: string) => KNOWN_SETTINGS.find((s) => s.key === key)?.category;

describe("setting categories after the move into the modules", () => {
  it("every category a setting uses has an explicit rule for who manages it", () => {
    const missing = [...new Set(KNOWN_SETTINGS.map((s) => s.category))].filter((c) => !(c in SETTING_CATEGORY_MANAGE_PERMISSION));
    expect(missing).toEqual([]);
  });

  it("the monitoring settings are split by the page that edits them, all managed by Monitoring admins", () => {
    for (const c of ["monitoring", "unifi", "dns", "ipam", "ups"]) expect(SETTING_CATEGORY_MANAGE_PERMISSION[c]).toBe(PERMISSIONS.MONITORS_WRITE_ANY);
    expect(categoryOf("unifi.controller_url")).toBe("unifi");
    expect(categoryOf("unifi.api_key")).toBe("unifi");
    expect(categoryOf("dns.primary_url")).toBe("dns");
    expect(categoryOf("dns.sync_enabled")).toBe("dns");
    expect(categoryOf("monitoring.ipam_scan_enabled")).toBe("ipam");
    expect(categoryOf("monitoring.ups_poll_interval_min")).toBe("ups");
    expect(categoryOf("monitoring.tick_seconds")).toBe("monitoring");
    expect(categoryOf("monitoring.history_retention_days")).toBe("monitoring");
    for (const k of Object.values(ALERT_KEYS)) expect(categoryOf(k), k).toBe("monitoring");
  });

  it("the unifi and dns categories hold nothing but their own keys", () => {
    for (const s of KNOWN_SETTINGS) {
      if (s.category === "unifi") expect(s.key.startsWith("unifi."), s.key).toBe(true);
      if (s.category === "dns") expect(s.key.startsWith("dns."), s.key).toBe(true);
      if (s.category === "ipam") expect(s.key.startsWith("monitoring.ipam_"), s.key).toBe(true);
      if (s.category === "ups") expect(s.key.startsWith("monitoring.ups_"), s.key).toBe(true);
    }
  });

  it("a switch and the settings it needs are always on the same page, so the form can tell what is missing", () => {
    for (const t of TOGGLE_PREREQUISITES) {
      const where = new Set([t.toggleKey, ...t.requires].map(categoryOf));
      expect(where.size, t.toggleKey).toBeLessThanOrEqual(t.toggleKey.startsWith("auth.") ? 2 : 1);
    }
  });

  it("the Assistant is set up by its own admin tier", () => {
    expect(SETTING_CATEGORY_MANAGE_PERMISSION.assistant).toBe(PERMISSIONS.ASSISTANT_ADMIN);
  });
});
