import { describe, expect, it } from "vitest";
import { maintenanceState, parseMaintenanceUntil } from "@church/shared";
import { MaintenanceExpiry } from "../src/monitors/maintenance-expiry";
import { readMaintenance } from "../src/monitors/maintenance";

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

describe("maintenance state", () => {
  it("is off unless the switch is exactly on", () => {
    for (const v of [false, undefined, null, "true", 1, 0]) expect(maintenanceState(v, iso(NOW + 1000), NOW).active).toBe(false);
  });
  it("has no end by default", () => {
    expect(maintenanceState(true, "", NOW)).toEqual({ active: true, until: null, expired: false });
    expect(maintenanceState(true, undefined, NOW)).toEqual({ active: true, until: null, expired: false });
  });
  it("is active until its end time and not after", () => {
    expect(maintenanceState(true, iso(NOW + 60_000), NOW)).toEqual({ active: true, until: NOW + 60_000, expired: false });
    expect(maintenanceState(true, iso(NOW), NOW)).toMatchObject({ active: false, expired: true });
    expect(maintenanceState(true, iso(NOW - 1), NOW)).toMatchObject({ active: false, expired: true });
  });
  it("an unreadable end time does not switch it off", () => {
    expect(maintenanceState(true, "tomorrow-ish", NOW)).toEqual({ active: true, until: null, expired: false });
    expect(parseMaintenanceUntil(12345)).toBeNull();
  });
  it("an off switch ignores a leftover end time", () => {
    expect(maintenanceState(false, iso(NOW + 60_000), NOW)).toEqual({ active: false, until: null, expired: false });
  });
});

function fakeSettings(initial: Record<string, unknown>) {
  const values = { ...initial };
  const writes: Array<[string, unknown]> = [];
  return {
    values,
    writes,
    get: async (k: string) => values[k],
    set: async (k: string, v: unknown) => {
      values[k] = v;
      writes.push([k, v]);
    },
  };
}

describe("reading maintenance from settings", () => {
  it("applies the end time to the stored switch", async () => {
    const s = fakeSettings({ "monitoring.maintenance_mode": true, "monitoring.maintenance_until": iso(NOW + 60_000) });
    expect((await readMaintenance(s, NOW)).active).toBe(true);
    expect((await readMaintenance(s, NOW + 61_000)).active).toBe(false);
  });
  it("a failing read is not maintenance (an alert is better sent twice than lost)", async () => {
    const s = { get: async () => { throw new Error("db down"); } };
    expect((await readMaintenance(s as never, NOW)).active).toBe(false);
  });
});

describe("maintenance expiry job", () => {
  const job = (s: ReturnType<typeof fakeSettings>) => new MaintenanceExpiry({ register: () => undefined } as never, s as never);
  it("switches an expired window off and clears its end time", async () => {
    const s = fakeSettings({ "monitoring.maintenance_mode": true, "monitoring.maintenance_until": iso(NOW - 1000) });
    expect(await job(s).run(NOW)).toBe(true);
    expect(s.values["monitoring.maintenance_mode"]).toBe(false);
    expect(s.values["monitoring.maintenance_until"]).toBe("");
  });
  it("leaves a running window, one with no end, and an off switch alone", async () => {
    for (const init of [
      { "monitoring.maintenance_mode": true, "monitoring.maintenance_until": iso(NOW + 60_000) },
      { "monitoring.maintenance_mode": true, "monitoring.maintenance_until": "" },
      { "monitoring.maintenance_mode": false, "monitoring.maintenance_until": iso(NOW - 60_000) },
    ]) {
      const s = fakeSettings(init);
      expect(await job(s).run(NOW)).toBe(false);
      expect(s.writes).toEqual([]);
    }
  });
});
