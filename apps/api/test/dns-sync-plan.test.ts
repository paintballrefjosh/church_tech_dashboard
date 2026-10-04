import { describe, expect, it } from "vitest";
import { DNS_MANAGED_MARKER } from "@church/shared";
import {
  computeSyncPlan,
  toDnsLabel,
  ptrName,
  recordKey,
  type ExistingRecord,
  type PlanHost,
  type PlanInput,
} from "../src/dns/sync-plan";

const NOW = new Date("2026-10-03T12:00:00Z");
const daysAgo = (d: number): Date => new Date(NOW.getTime() - d * 86_400_000);

function host(id: string, ip: string, over: Partial<PlanHost> = {}): PlanHost {
  return { id, ipAddress: ip, dnsName: null, unifiName: null, netbiosName: null, lastSeenAt: daysAgo(0), ...over };
}

function rec(zone: string, name: string, type: string, value: string, managed = true, ttl = 300): ExistingRecord {
  return { zone, name, type, value, ttl, comments: managed ? DNS_MANAGED_MARKER : null };
}

function plan(over: Partial<PlanInput>) {
  return computeSyncPlan({
    enabled: true,
    zone: "int.example.org",
    ptr: true,
    ttl: 300,
    staleDays: 14,
    now: NOW,
    hosts: [],
    zones: ["int.example.org", "10.10.in-addr.arpa"],
    existing: [],
    ledger: new Map(),
    ...over,
  });
}

describe("toDnsLabel", () => {
  it("cleans friendly names into one label", () => {
    expect(toDnsLabel("Josh's iPhone")).toBe("joshs-iphone");
    expect(toDnsLabel("OFFICE-PC")).toBe("office-pc");
    expect(toDnsLabel("laptop.lan")).toBe("laptop");
    expect(toDnsLabel("  Café Printer #2 ")).toBe("cafe-printer-2");
    expect(toDnsLabel("---")).toBeNull();
    expect(toDnsLabel(null)).toBeNull();
    expect(toDnsLabel("x".repeat(80))).toHaveLength(63);
  });
});

describe("ptrName", () => {
  it("reverses an IPv4 address", () => {
    expect(ptrName("10.10.0.25")).toBe("25.0.10.10.in-addr.arpa");
  });
});

describe("computeSyncPlan", () => {
  it("adds A and PTR for a new named host", () => {
    const p = plan({ hosts: [host("h1", "10.10.0.5", { unifiName: "Lobby Printer" })] });
    expect(p.actions.map((a) => [a.op, a.type, a.name, a.value])).toEqual([
      ["add", "A", "lobby-printer.int.example.org", "10.10.0.5"],
      ["add", "PTR", "5.0.10.10.in-addr.arpa", "lobby-printer.int.example.org"],
    ]);
    expect(p.hosts.h1).toMatchObject({ state: "ok", fqdn: "lobby-printer.int.example.org" });
    expect(p.blocked).toBeNull();
  });

  it("prefers the override, then UniFi, then NetBIOS, and never the reverse-DNS name", () => {
    const p = plan({
      ptr: false,
      hosts: [
        host("a", "10.10.0.1", { dnsName: "core-sw", unifiName: "Switch", netbiosName: "SW" }),
        host("b", "10.10.0.2", { netbiosName: "FRONT-DESK" }),
      ],
    });
    expect(p.actions.map((a) => a.name)).toEqual(["core-sw.int.example.org", "front-desk.int.example.org"]);
  });

  it("skips unnamed and stale hosts", () => {
    const p = plan({
      hosts: [host("u", "10.10.0.7"), host("s", "10.10.0.8", { unifiName: "Old", lastSeenAt: daysAgo(30) })],
    });
    expect(p.actions).toEqual([]);
    expect(p.hosts.u?.state).toBe("unnamed");
    expect(p.hosts.s?.state).toBe("stale");
  });

  it("gives the most recently seen host the name and suffixes the other", () => {
    const p = plan({
      ptr: false,
      hosts: [
        host("old", "10.10.0.20", { unifiName: "iPad", lastSeenAt: daysAgo(2) }),
        host("new", "10.10.0.21", { unifiName: "iPad", lastSeenAt: daysAgo(0) }),
      ],
    });
    expect(p.hosts.new?.fqdn).toBe("ipad.int.example.org");
    expect(p.hosts.old?.fqdn).toBe("ipad-20.int.example.org");
  });

  it("lets an override win a contested name", () => {
    const p = plan({
      ptr: false,
      hosts: [
        host("disc", "10.10.0.30", { unifiName: "printer", lastSeenAt: daysAgo(0) }),
        host("ovr", "10.10.0.31", { dnsName: "printer", lastSeenAt: daysAgo(3) }),
      ],
    });
    expect(p.hosts.ovr?.fqdn).toBe("printer.int.example.org");
    expect(p.hosts.disc?.fqdn).toBe("printer-30.int.example.org");
  });

  it("reports a conflict instead of touching a hand-made record", () => {
    const p = plan({
      ptr: false,
      hosts: [host("h", "10.10.0.5", { unifiName: "nas" })],
      existing: [rec("int.example.org", "nas.int.example.org", "A", "10.10.0.99", false)],
    });
    expect(p.actions).toEqual([]);
    expect(p.conflicts).toHaveLength(1);
    expect(p.conflicts[0]?.existing).toBe("A 10.10.0.99");
    expect(p.hosts.h?.state).toBe("conflict");
  });

  it("skips the PTR of a host whose A record conflicts", () => {
    const p = plan({
      hosts: [host("h", "10.10.0.7", { unifiName: "nas" })],
      existing: [
        rec("int.example.org", "nas.int.example.org", "A", "10.10.0.99", false),
        rec("10.10.in-addr.arpa", "7.0.10.10.in-addr.arpa", "PTR", "nas.int.example.org"),
      ],
    });
    expect(p.conflicts.map((c) => c.type)).toEqual(["A"]);
    // The old synced PTR goes, and no new one is written.
    expect(p.actions).toEqual([expect.objectContaining({ op: "remove", type: "PTR" })]);
    expect(p.published).toEqual([]);
  });

  it("treats a hand-made CNAME at the name as a conflict", () => {
    const p = plan({
      ptr: false,
      hosts: [host("h", "10.10.0.5", { unifiName: "www" })],
      existing: [rec("int.example.org", "www.int.example.org", "CNAME", "web.int.example.org", false)],
    });
    expect(p.conflicts).toHaveLength(1);
  });

  it("leaves a correct record alone and updates a moved one", () => {
    const p = plan({
      ptr: false,
      hosts: [host("a", "10.10.0.5", { unifiName: "same" }), host("b", "10.10.0.6", { unifiName: "moved" })],
      existing: [
        rec("int.example.org", "same.int.example.org", "A", "10.10.0.5"),
        rec("int.example.org", "moved.int.example.org", "A", "10.10.0.66"),
      ],
    });
    expect(p.unchanged).toBe(1);
    expect(p.actions).toEqual([
      expect.objectContaining({ op: "update", name: "moved.int.example.org", fromValue: "10.10.0.66", value: "10.10.0.6" }),
    ]);
  });

  it("updates a record whose TTL drifted", () => {
    const p = plan({
      ptr: false,
      hosts: [host("a", "10.10.0.5", { unifiName: "x" })],
      existing: [rec("int.example.org", "x.int.example.org", "A", "10.10.0.5", true, 3600)],
    });
    expect(p.actions).toEqual([expect.objectContaining({ op: "update", value: "10.10.0.5", fromValue: "10.10.0.5" })]);
  });

  it("removes managed records nobody wants, with a reason from the ledger", () => {
    const key = recordKey("int.example.org", "gone.int.example.org", "A");
    const p = plan({
      ptr: false,
      hosts: [host("s", "10.10.0.9", { unifiName: "gone", lastSeenAt: daysAgo(40) })],
      existing: [
        rec("int.example.org", "gone.int.example.org", "A", "10.10.0.9"),
        rec("int.example.org", "manual.int.example.org", "A", "10.10.0.10", false),
      ],
      ledger: new Map([[key, "s"]]),
    });
    expect(p.actions).toEqual([
      expect.objectContaining({ op: "remove", name: "gone.int.example.org", reason: "Host not seen for 14+ days" }),
    ]);
  });

  it("reports a missing reverse zone and still adds the A record", () => {
    const p = plan({ zones: ["int.example.org"], hosts: [host("h", "192.168.5.7", { unifiName: "cam" })] });
    expect(p.actions.map((a) => a.type)).toEqual(["A"]);
    expect(p.missingReverseZones).toEqual(["5.168.192.in-addr.arpa"]);
  });

  it("uses the longest matching reverse zone", () => {
    const p = plan({
      zones: ["int.example.org", "10.in-addr.arpa", "0.10.10.in-addr.arpa"],
      hosts: [host("h", "10.10.0.4", { unifiName: "ap" })],
    });
    expect(p.actions.find((a) => a.type === "PTR")?.zone).toBe("0.10.10.in-addr.arpa");
  });

  it("trips the safety limit on a mass removal", () => {
    const existing = Array.from({ length: 30 }, (_, i) => rec("int.example.org", `h${i}.int.example.org`, "A", `10.10.1.${i}`));
    const p = plan({ ptr: false, hosts: [], existing });
    expect(p.actions.filter((a) => a.op === "remove")).toHaveLength(30);
    expect(p.blocked).toMatch(/remove 30 of 30/);
  });

  it("does not trip the safety limit for a couple of removals in a small set", () => {
    const existing = [rec("int.example.org", "a.int.example.org", "A", "10.10.1.1"), rec("int.example.org", "b.int.example.org", "A", "10.10.1.2")];
    const p = plan({ ptr: false, hosts: [], existing });
    expect(p.blocked).toBeNull();
  });
});
