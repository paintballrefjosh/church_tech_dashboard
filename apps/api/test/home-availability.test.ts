import { describe, expect, it } from "vitest";
import { availabilityCell, bucketAvailability, type AvailabilityRow } from "@church/shared";

const NOW = new Date("2026-10-11T14:25:00Z");
const row = (kind: string, ref: string, label: string, hour: string, samples: number, down: number): AvailabilityRow => ({
  kind,
  ref,
  label,
  hour,
  samples,
  down,
});
const KINDS = ["infra_target", "monitor", "unifi_device", "cisco_switch", "dns_node"];

describe("availabilityCell", () => {
  it("classifies", () => {
    expect(availabilityCell(0, 0)).toBe("none");
    expect(availabilityCell(6, 0)).toBe("up");
    expect(availabilityCell(6, 1)).toBe("partial");
    expect(availabilityCell(6, 3)).toBe("down");
    expect(availabilityCell(6, 6)).toBe("down");
  });
});

describe("bucketAvailability", () => {
  it("lists 12 hours newest first and cells newest first", () => {
    const g = bucketAvailability(
      [
        row("monitor", "m1", "Site", "2026-10-11T14:00:00.000Z", 4, 0),
        row("monitor", "m1", "Site", "2026-10-11T12:00:00.000Z", 4, 4),
        row("monitor", "m1", "Site", "2026-10-11T11:00:00.000Z", 4, 1),
      ],
      { now: NOW, hours: 12, kinds: KINDS },
    );
    expect(g.hours).toHaveLength(12);
    expect(g.hours[0]).toBe("2026-10-11T14:00:00.000Z");
    expect(g.hours[11]).toBe("2026-10-11T03:00:00.000Z");
    const s = g.groups[0]!.systems[0]!;
    expect(s.cells.slice(0, 4)).toEqual(["up", "none", "down", "partial"]);
    expect(s.cells[11]).toBe("none");
    expect(s.href).toBe("/monitoring/m1");
  });

  it("orders groups, sorts systems, omits empty groups and other kinds", () => {
    const h = "2026-10-11T14:00:00.000Z";
    const g = bucketAvailability(
      [
        row("dns_node", "ns1", "ns1", h, 1, 0),
        row("infra_target", "b", "beta", h, 1, 0),
        row("infra_target", "a", "alpha", h, 1, 1),
        row("unifi_device", "aa:bb", "AP", h, 1, 0),
        row("cisco_switch", "c", "SW", "2026-10-10T01:00:00.000Z", 1, 0),
      ],
      { now: NOW, hours: 12, kinds: ["infra_target", "dns_node", "cisco_switch"] },
    );
    expect(g.groups.map((x) => x.area)).toEqual(["servers", "dns"]);
    expect(g.groups[0]!.systems.map((x) => x.name)).toEqual(["alpha", "beta"]);
    expect(g.groups[0]!.systems[0]!.href).toBe("/monitoring/infra/a");
    expect(g.groups[1]!.systems[0]!.href).toBe("/dns");
  });

  it("uses the newest label and handles no rows", () => {
    const g = bucketAvailability(
      [row("monitor", "m", "New", "2026-10-11T14:00:00.000Z", 1, 0), row("monitor", "m", "Old", "2026-10-11T13:00:00.000Z", 1, 0)],
      { now: NOW, hours: 12, kinds: KINDS },
    );
    expect(g.groups[0]!.systems[0]!.name).toBe("New");
    expect(bucketAvailability([], { now: NOW, hours: 12, kinds: KINDS }).groups).toEqual([]);
  });
});
