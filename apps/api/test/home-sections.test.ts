import { describe, expect, it } from "vitest";
import { sectionSchema, systemsHealthSchema, ticketDigestSchema, nextServiceSchema } from "@church/shared";
import { HomeSystemsSection } from "../src/dashboard/home/sections/systems.section";
import { HomeTicketsSection } from "../src/dashboard/home/sections/tickets.section";
import { HomeServiceSection, mapPlan, markMe } from "../src/dashboard/home/sections/service.section";
import { HomeChecklistsSection } from "../src/dashboard/home/sections/checklists.section";
import type { HomeContext } from "../src/dashboard/home/home.types";
import type { SettingsService } from "../src/settings/settings.service";
import type { MonitorsService } from "../src/monitors/monitors.service";
import type { InfraService } from "../src/infra/infra.service";
import type { UnifiService } from "../src/unifi/unifi.service";
import type { CiscoService } from "../src/cisco/cisco.service";
import type { DnsService } from "../src/dns/dns.service";
import type { TicketsService } from "../src/tickets/tickets.service";
import type { PlanningCenterService } from "../src/planning-center/planning-center.service";
import type { ChecklistsService } from "../src/checklists/checklists.service";
import type { Db } from "../src/db/db.module";
import { NOW, TZ } from "./helpers/home-fixtures";

const ctx = (permissions: string[], id = "me"): HomeContext =>
  ({ user: { id, permissions }, now: NOW, timezone: TZ, includes: new Set() }) as unknown as HomeContext;

const settings = (values: Record<string, unknown> = {}) =>
  ({ get: async (k: string) => values[k] }) as unknown as SettingsService;

const never = new Promise<never>(() => undefined);

interface SystemFakes {
  infraSummary?: () => Promise<unknown>;
  monitorsSummary?: () => Promise<unknown>;
  unifiSummary?: () => Promise<unknown>;
  unifiDevices?: () => Promise<unknown[]>;
  cisco?: () => Promise<unknown[]>;
  dns?: () => Promise<unknown>;
}

function systems(f: SystemFakes = {}, values: Record<string, unknown> = {}) {
  const calls = { unifiSummary: 0, dns: 0 };
  const infra = {
    summary: f.infraSummary ?? (async () => ({ targets: { up: 3, down: 1, degraded: 1, unknown: 0, total: 5, disabled: 1 } })),
    list: async () => [
      { id: "s1", name: "Files", enabled: true, status: "down", lastError: "ssh timeout" },
      { id: "s2", name: "Web", enabled: true, status: "degraded", lastError: null },
      { id: "s3", name: "Old", enabled: false, status: "down", lastError: null },
      { id: "s4", name: "Fine", enabled: true, status: "up", lastError: null },
    ],
    openIncidents: async () => [
      { targetId: "s1", startedAt: new Date("2026-10-08T08:00:00Z") },
      { targetId: "s1", startedAt: new Date("2026-10-08T07:00:00Z") },
    ],
  } as unknown as InfraService;
  const monitors = {
    summary: f.monitorsSummary ?? (async () => ({ total: 3, up: 2, down: 1, unknown: 0 })),
    list: async () => [
      { id: "m1", name: "Website", status: "down", enabled: true, target: "https://x" },
      { id: "m2", name: "Other", status: "up", enabled: true, target: "y" },
    ],
    openIncidents: async () => [{ monitorId: "m1", startedAt: new Date("2026-10-08T09:00:00Z"), reason: "HTTP 500" }],
  } as unknown as MonitorsService;
  const unifi = {
    summary: async () => {
      calls.unifiSummary++;
      return f.unifiSummary
        ? f.unifiSummary()
        : { configured: true, reachable: true, error: null, devices: { total: 3, online: 2, offline: 1, acked: 0 }, clients: {} };
    },
    devices:
      f.unifiDevices ??
      (async () => [
        { name: "AP-Kids-Wing", mac: "AA:BB:CC", state: 0, acked: false, last_seen: 1_791_000_000 },
        { name: "AP-Hall", mac: "DD", state: 1 },
      ]),
  } as unknown as UnifiService;
  const cisco = {
    list: f.cisco ?? (async () => [
      { id: "c1", hostname: "core", reachable: true, lastError: null },
      { id: "c2", hostname: "edge", reachable: false, lastError: "ssh refused" },
    ]),
  } as unknown as CiscoService;
  const dns = {
    summary: async () => {
      calls.dns++;
      return f.dns
        ? f.dns()
        : {
            configured: true,
            reachable: true,
            error: null,
            nodes: [
              { name: "ns1", state: "Self", lastSeen: null, ipAddress: "1" },
              { name: "ns2", state: "Unreachable", lastSeen: "2026-10-08T06:00:00.000Z", ipAddress: "2" },
            ],
            unreachableNodes: 1,
          };
    },
  } as unknown as DnsService;
  return { section: new HomeSystemsSection(settings(values), monitors, infra, unifi, cisco, dns), calls };
}

const MON = ["monitors:read:any"];

describe("HomeSystemsSection", () => {
  it("is forbidden without monitors:read:any", async () => {
    expect(await systems().section.build(ctx([]))).toEqual({ state: "forbidden" });
  });

  it("builds every area and problem, and validates against the schema", async () => {
    const res = await systems().section.build(ctx([...MON, "unifi:read:any", "monitors:write:any"]));
    expect(res.state).toBe("ok");
    if (res.state !== "ok") return;
    expect(sectionSchema(systemsHealthSchema).safeParse(res).success).toBe(true);
    const byKey = Object.fromEntries(res.data.areas.map((a) => [a.key, a]));
    // Degraded counts as down; disabled targets are not in the total.
    expect(byKey.servers).toMatchObject({ state: "ok", up: 3, down: 2, total: 5 });
    expect(byKey.internet).toMatchObject({ up: 2, down: 1, total: 3 });
    expect(byKey.wifi).toMatchObject({ up: 2, down: 1, total: 3 });
    expect(byKey.switches).toMatchObject({ up: 1, down: 1, total: 2 });
    expect(byKey.dns).toMatchObject({ up: 1, down: 1, total: 2 });
    expect(res.data.canWrite).toBe(true);
    expect(res.data.maintenanceMode).toBe(false);

    const byId = Object.fromEntries(res.data.problems.map((p) => [p.id, p]));
    expect(Object.keys(byId).sort()).toEqual(
      ["dns:ns2", "internet:m1", "servers:s1", "servers:s2", "switches:c2", "wifi:aa:bb:cc"].sort(),
    );
    // The earliest open incident is the start of the outage.
    expect(byId["servers:s1"]).toMatchObject({ since: "2026-10-08T07:00:00.000Z", detail: "ssh timeout", href: "/monitoring/infra/s1" });
    expect(byId["internet:m1"]).toMatchObject({ since: "2026-10-08T09:00:00.000Z", detail: "HTTP 500", href: "/monitoring/m1" });
    expect(byId["wifi:aa:bb:cc"]).toMatchObject({ name: "AP-Kids-Wing", ack: { kind: "unifi", mac: "aa:bb:cc", acked: false } });
    expect(byId["wifi:aa:bb:cc"]!.since).toBe(new Date(1_791_000_000 * 1000).toISOString());
    expect(byId["dns:ns2"]).toMatchObject({ since: "2026-10-08T06:00:00.000Z", detail: "Unreachable" });
    expect(res.data.totals).toEqual({ up: 9, down: 6, total: 15 });
  });

  it("marks the wifi area forbidden without unifi:read:any, and never calls the controller", async () => {
    const { section, calls } = systems();
    const res = await section.build(ctx(MON));
    expect(res.state).toBe("ok");
    if (res.state !== "ok") return;
    expect(res.data.areas.find((a) => a.key === "wifi")?.state).toBe("forbidden");
    expect(res.data.problems.some((p) => p.area === "wifi")).toBe(false);
    expect(res.data.canWrite).toBe(false);
    expect(calls.unifiSummary).toBe(0);
  });

  it("keeps the other areas when one source is unreachable or slow", async () => {
    const { section } = systems({
      unifiSummary: async () => ({ configured: true, reachable: false, error: "x", devices: { total: 0, online: 0, offline: 0, acked: 0 }, clients: {} }),
      dns: () => never,
      cisco: async () => {
        throw new Error("db");
      },
    });
    const res = await section.build(ctx([...MON, "unifi:read:any"]));
    expect(res.state).toBe("ok");
    if (res.state !== "ok") return;
    const state = Object.fromEntries(res.data.areas.map((a) => [a.key, [a.state, a.note]]));
    expect(state.wifi).toEqual(["unavailable", "controller unreachable"]);
    expect(state.dns).toEqual(["unavailable", "timed out"]);
    expect(state.switches?.[0]).toBe("unavailable");
    expect(state.servers?.[0]).toBe("ok");
    expect(res.data.totals.total).toBe(8);
  });

  it("marks unconfigured sources", async () => {
    const { section } = systems({
      infraSummary: async () => ({ targets: { up: 0, down: 0, degraded: 0, unknown: 0, total: 0, disabled: 0 } }),
      monitorsSummary: async () => ({ total: 0, up: 0, down: 0, unknown: 0 }),
      unifiSummary: async () => ({ configured: false, reachable: false, error: null, devices: { total: 0, online: 0, offline: 0, acked: 0 }, clients: {} }),
      cisco: async () => [],
      dns: async () => ({ configured: false, reachable: false, error: null, nodes: null, unreachableNodes: 0 }),
    });
    const res = await section.build(ctx([...MON, "unifi:read:any"]));
    if (res.state !== "ok") throw new Error("expected ok");
    expect(res.data.areas.map((a) => a.state)).toEqual(["unconfigured", "unconfigured", "unconfigured", "unconfigured", "unconfigured"]);
    expect(res.data.problems).toEqual([]);
  });

  it("treats an unreachable DNS primary as an outage", async () => {
    const { section } = systems({
      dns: async () => ({ configured: true, reachable: false, error: "refused", nodes: null, unreachableNodes: 0 }),
    });
    const res = await section.build(ctx(MON));
    if (res.state !== "ok") throw new Error("expected ok");
    expect(res.data.areas.find((a) => a.key === "dns")).toMatchObject({ state: "ok", down: 1, total: 1 });
    expect(res.data.problems.find((p) => p.area === "dns")?.name).toBe("DNS primary");
  });

  it("caches the controller and DNS reads between requests", async () => {
    const { section, calls } = systems();
    await section.build(ctx([...MON, "unifi:read:any"]));
    await section.build(ctx([...MON, "unifi:read:any"]));
    expect(calls.unifiSummary).toBe(1);
    expect(calls.dns).toBe(1);
  });

  it("reads maintenance mode", async () => {
    const res = await systems({}, { "monitoring.maintenance_mode": true }).section.build(ctx(MON));
    if (res.state !== "ok") throw new Error("expected ok");
    expect(res.data.maintenanceMode).toBe(true);
  });
});

// ---- tickets ----

interface FakeTicket {
  id: string;
  number: number;
  title: string;
  status: string;
  priority: string;
  createdByUserId: string;
  assignedUserId: string | null;
  createdAt: Date;
  firstResponseAt: Date | null;
  resolvedAt: Date | null;
}

const ticket = (over: Partial<FakeTicket>): FakeTicket => ({
  id: "t1",
  number: 1,
  title: "A ticket",
  status: "open",
  priority: "normal",
  createdByUserId: "req",
  assignedUserId: null,
  createdAt: new Date("2026-10-08T10:00:00Z"),
  firstResponseAt: null,
  resolvedAt: null,
  ...over,
});

function ticketSection(rows: FakeTicket[], sla: Record<string, number> = {}) {
  const listed: unknown[] = [];
  const tickets = {
    list: async (_u: unknown, q: unknown) => {
      listed.push(q);
      return rows;
    },
  } as unknown as TicketsService;
  const values: Record<string, unknown> = {};
  for (const [p, m] of Object.entries(sla)) values[`tickets.sla.response_min.${p}`] = m;
  // Only the user lookup is used by the section.
  const db = {
    select: () => ({ from: () => ({ where: async () => [{ id: "req", name: "Grace Hopper", email: "g@x" }] }) }),
  } as unknown as Db;
  return { section: new HomeTicketsSection(tickets, settings(values), db), listed };
}

describe("HomeTicketsSection", () => {
  it("is forbidden without tickets:read:own", async () => {
    expect(await ticketSection([]).section.build(ctx([]))).toEqual({ state: "forbidden" });
  });

  it("builds the digest for staff: assigned tickets, SLA, unassigned count", async () => {
    const rows = [
      ticket({ id: "a", number: 1, assignedUserId: "me", createdAt: new Date("2026-10-08T08:00:00Z") }),
      ticket({ id: "b", number: 2, assignedUserId: "me", priority: "high", createdAt: new Date("2026-10-08T11:30:00Z") }),
      ticket({ id: "c", number: 3, assignedUserId: "me", createdAt: new Date("2026-10-08T07:00:00Z"), firstResponseAt: new Date("2026-10-08T07:30:00Z") }),
      ticket({ id: "d", number: 4, assignedUserId: null }),
      ticket({ id: "e", number: 5, assignedUserId: "other" }),
    ];
    const { section, listed } = ticketSection(rows, { normal: 240, high: 60 });
    const res = await section.build(ctx(["tickets:read:own", "tickets:read:any", "tickets:admin"]));
    expect(res.state).toBe("ok");
    if (res.state !== "ok") return;
    expect(sectionSchema(ticketDigestSchema).safeParse(res).success).toBe(true);
    expect(listed[0]).toMatchObject({ scope: "all" });
    // Newest first: b (11:30), a (08:00), c (07:00).
    expect(res.data.mine.map((m) => m.id)).toEqual(["b", "a", "c"]);
    const [b, a, c] = res.data.mine;
    // b: high, 60 min target, created 11:30Z, now 12:00Z -> due 12:30Z, not breached.
    expect(b).toMatchObject({ responseDueAt: "2026-10-08T12:30:00.000Z", responseBreached: false, requesterName: "Grace Hopper", assignedToMe: true, href: "/tickets/b" });
    // a: normal, 240 min, created 08:00Z -> due 12:00Z; exactly now is not yet breached.
    expect(a).toMatchObject({ responseDueAt: "2026-10-08T12:00:00.000Z", responseBreached: false });
    // c: already answered.
    expect(c).toMatchObject({ responseDueAt: null, responseBreached: false });
    expect(res.data.unassignedCount).toBe(1);
    expect(res.data.openCount).toBe(5);
    expect(res.data.canAssign).toBe(true);
  });

  it("flags a breached response", async () => {
    const { section } = ticketSection([ticket({ assignedUserId: "me", createdAt: new Date("2026-10-08T06:00:00Z") })], { normal: 60 });
    const res = await section.build(ctx(["tickets:read:own", "tickets:read:any"]));
    if (res.state !== "ok") throw new Error("expected ok");
    expect(res.data.mine[0]).toMatchObject({ responseBreached: true, responseDueAt: "2026-10-08T07:00:00.000Z" });
  });

  it("gives no due time when the target is 0", async () => {
    const { section } = ticketSection([ticket({ assignedUserId: "me" })]);
    const res = await section.build(ctx(["tickets:read:own", "tickets:read:any"]));
    if (res.state !== "ok") throw new Error("expected ok");
    expect(res.data.mine[0]).toMatchObject({ responseDueAt: null, responseBreached: false });
  });

  it("for a person with only tickets:read:own shows their own tickets, no unassigned count, cannot assign", async () => {
    const rows = [ticket({ id: "mine", createdByUserId: "me" }), ticket({ id: "x", createdByUserId: "me", assignedUserId: null })];
    const { section, listed } = ticketSection(rows);
    const res = await section.build(ctx(["tickets:read:own"]));
    if (res.state !== "ok") throw new Error("expected ok");
    expect(listed[0]).toMatchObject({ scope: "own" });
    expect(res.data.mine).toHaveLength(2);
    expect(res.data.unassignedCount).toBe(0);
    expect(res.data.canAssign).toBe(false);
  });

  it("limits mine to 10", async () => {
    const rows = Array.from({ length: 14 }, (_, i) => ticket({ id: `t${i}`, number: i, assignedUserId: "me", createdAt: new Date(2026, 9, 1, 0, i) }));
    const res = await ticketSection(rows).section.build(ctx(["tickets:read:own", "tickets:read:any"]));
    if (res.state !== "ok") throw new Error("expected ok");
    expect(res.data.mine).toHaveLength(10);
    expect(res.data.openCount).toBe(14);
  });
});

// ---- service ----

function pcFake(opts: {
  plans?: unknown[];
  health?: { configured: boolean; reachable: boolean; error: string | null };
  fail?: boolean;
}) {
  const calls = { plans: 0, detail: 0 };
  const pc = {
    listUpcomingPlans: async () => {
      calls.plans++;
      if (opts.fail) throw new Error("PC down");
      return opts.plans ?? [];
    },
    health: async () => opts.health ?? { configured: true, reachable: true, error: null },
    planDetail: async () => {
      calls.detail++;
      return {
        plan: null,
        times: [
          { id: "r", startsAt: "2026-10-11T07:30:00Z", endsAt: null, description: null, kind: "rehearsal", name: "Rehearsal" },
          { id: "s1", startsAt: "2026-10-11T09:00:00Z", endsAt: "2026-10-11T10:00:00Z", description: null, kind: "service", name: "Morning" },
        ],
        assignments: [
          { positionName: "Vocals", teamMemberId: "1", pcPersonId: "p1", pcPersonName: "Ann", status: "C", localUserId: "me" },
          { positionName: "Vocals", teamMemberId: "2", pcPersonId: "p2", pcPersonName: "Bo", status: "U", localUserId: null },
          { positionName: "Bass", teamMemberId: "3", pcPersonId: "p3", pcPersonName: "Cy", status: "D", localUserId: null },
        ],
      };
    },
  } as unknown as PlanningCenterService;
  return { pc, calls };
}

const PLAN = { id: "p9", title: "Sunday Gathering", sortDate: "2026-10-11T07:30:00Z", seriesTitle: "Hope", serviceTypeId: "st1", serviceTypeName: "Sunday" };

function checklistsFake(events: Array<{ id: string; name: string; scheduledAt: Date | null }>) {
  return { listEvents: async () => events } as unknown as ChecklistsService;
}

describe("HomeServiceSection", () => {
  it("is forbidden with neither permission", async () => {
    const { pc } = pcFake({});
    expect(await new HomeServiceSection(pc, checklistsFake([])).build(ctx([]))).toEqual({ state: "forbidden" });
  });

  it("maps the plan, marks the person, and caches globally (not per person)", async () => {
    const { pc, calls } = pcFake({ plans: [PLAN] });
    const section = new HomeServiceSection(pc, checklistsFake([]));
    const mine = await section.build(ctx(["planning_center:read:any"], "me"));
    expect(mine.state).toBe("ok");
    if (mine.state !== "ok") return;
    expect(sectionSchema(nextServiceSchema).safeParse(mine).success).toBe(true);
    expect(mine.data).toMatchObject({
      source: "planning_center",
      title: "Sunday Gathering",
      seriesTitle: "Hope",
      serviceTypeName: "Sunday",
      href: "/planning-center/st1/p9",
      // The first service time, not the earlier rehearsal.
      startsAt: "2026-10-11T09:00:00Z",
    });
    expect(mine.data.times.map((t) => [t.kind, t.name])).toEqual([["rehearsal", "Rehearsal"], ["service", "Morning"]]);
    expect(mine.data.team).toMatchObject({ confirmed: 1, waiting: 1, declined: 1 });
    expect(mine.data.team!.positions.map((p) => p.name)).toEqual(["Vocals", "Bass"]);
    expect(mine.data.team!.positions[0]!.people.map((p) => [p.name, p.status, p.isMe])).toEqual([["Ann", "confirmed", true], ["Bo", "waiting", false]]);

    const other = await section.build(ctx(["planning_center:read:any"], "someone-else"));
    if (other.state !== "ok") throw new Error("expected ok");
    expect(other.data.team!.positions[0]!.people[0]!.isMe).toBe(false);
    // The first person's marker did not leak into the shared value.
    expect(mine.data.team!.positions[0]!.people[0]!.isMe).toBe(true);
    expect(calls.plans).toBe(1);
    expect(calls.detail).toBe(1);
  });

  it("falls back to the next checklist event when Planning Center is unconfigured", async () => {
    const { pc } = pcFake({ plans: [], health: { configured: false, reachable: false, error: null } });
    const events = [
      { id: "old", name: "Past", scheduledAt: new Date("2026-10-07T09:00:00Z") },
      { id: "e1", name: "Sunday setup", scheduledAt: new Date("2026-10-11T07:00:00Z") },
      { id: "e2", name: "Later", scheduledAt: new Date("2026-10-18T07:00:00Z") },
    ];
    const res = await new HomeServiceSection(pc, checklistsFake(events)).build(ctx(["planning_center:read:any", "checklists:read:assigned"]));
    expect(res).toMatchObject({ state: "ok", data: { source: "checklist", title: "Sunday setup", href: "/checklists/e1", startsAt: "2026-10-11T07:00:00.000Z", team: null } });
  });

  it("falls back when the person lacks Planning Center access, and when it is unreachable", async () => {
    const events = [{ id: "e1", name: "Setup", scheduledAt: new Date("2026-10-11T07:00:00Z") }];
    const { pc, calls } = pcFake({ plans: [PLAN] });
    const noPc = await new HomeServiceSection(pc, checklistsFake(events)).build(ctx(["checklists:read:assigned"]));
    expect(noPc.state).toBe("ok");
    expect(calls.plans).toBe(0);
    const broken = pcFake({ fail: true });
    const res = await new HomeServiceSection(broken.pc, checklistsFake(events)).build(ctx(["planning_center:read:any", "checklists:read:assigned"]));
    expect(res).toMatchObject({ state: "ok", data: { source: "checklist" } });
  });

  it("is unconfigured with no fallback, unavailable when PC is down or has nothing scheduled", async () => {
    const unconfigured = pcFake({ plans: [], health: { configured: false, reachable: false, error: null } });
    expect(await new HomeServiceSection(unconfigured.pc, checklistsFake([])).build(ctx(["planning_center:read:any"]))).toEqual({ state: "unconfigured" });
    const down = pcFake({ fail: true });
    expect((await new HomeServiceSection(down.pc, checklistsFake([])).build(ctx(["planning_center:read:any"]))).state).toBe("unavailable");
    const none = pcFake({ plans: [] });
    expect(await new HomeServiceSection(none.pc, checklistsFake([])).build(ctx(["planning_center:read:any"]))).toMatchObject({ state: "unavailable", reason: "no upcoming service" });
    // A checklist-only person with nothing upcoming.
    expect((await new HomeServiceSection(none.pc, checklistsFake([])).build(ctx(["checklists:read:assigned"]))).state).toBe("unavailable");
  });
});

describe("mapPlan", () => {
  it("falls back to the first time, then the plan's sort date, and has no team for an empty roster", () => {
    const detail = (times: Array<{ id: string; startsAt: string | null; kind: "service" | "rehearsal" | "other" }>) => ({
      plan: null,
      times: times.map((t) => ({ ...t, endsAt: null, description: "desc", name: null })),
      assignments: [],
    });
    expect(mapPlan(PLAN, detail([{ id: "1", startsAt: "2026-10-11T06:00:00Z", kind: "rehearsal" }])).startsAt).toBe("2026-10-11T06:00:00Z");
    const none = mapPlan(PLAN, detail([]));
    expect(none.startsAt).toBe(PLAN.sortDate);
    expect(none.team).toBeNull();
    expect(mapPlan(PLAN, detail([{ id: "1", startsAt: "2026-10-11T06:00:00Z", kind: "other" }])).times[0]!.name).toBe("desc");
  });
  it("markMe leaves a service without a team alone", () => {
    const svc = mapPlan(PLAN, { plan: null, times: [], assignments: [] });
    expect(markMe(svc, "me")).toBe(svc);
  });
});

describe("HomeChecklistsSection", () => {
  it("groups open tasks by event, capped at 5 events and 8 tasks", async () => {
    const rows = [];
    for (let e = 0; e < 7; e++) {
      for (let t = 0; t < 10; t++) {
        rows.push({ taskId: `t${e}-${t}`, eventId: `e${e}`, title: `Task ${t}`, positionName: "Stage", eventName: `Event ${e}`, scheduledAt: new Date("2026-10-11T07:00:00Z") });
      }
    }
    const section = new HomeChecklistsSection({ myOpenTasks: async () => rows } as unknown as ChecklistsService);
    const res = await section.build(ctx(["checklists:read:assigned"]));
    if (res.state !== "ok") throw new Error("expected ok");
    expect(res.data.events).toHaveLength(5);
    expect(res.data.events[0]!.tasks).toHaveLength(8);
    expect(res.data.events[0]).toMatchObject({ eventId: "e0", href: "/checklists/e0", name: "Event 0" });
    expect(res.data.events[0]!.tasks.every((t) => t.done === false)).toBe(true);
    expect(await section.build(ctx([]))).toEqual({ state: "forbidden" });
  });
});
