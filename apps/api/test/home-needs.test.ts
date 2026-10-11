import { describe, expect, it } from "vitest";
import { rankNeeds, sectionOk, sectionOff, type NeedItem } from "@church/shared";
import { buildNeedItems, groupFor, HomeNeedsSection } from "../src/dashboard/home/sections/needs.section";
import type { HomeContext } from "../src/dashboard/home/home.types";
import type { TicketsService } from "../src/tickets/tickets.service";
import {
  NOW,
  TZ,
  checklistsOk,
  primary,
  problem,
  serviceOk,
  systemsOk,
  ticketRow,
  ticketsOk,
} from "./helpers/home-fixtures";

function item(over: Partial<NeedItem>): NeedItem {
  return {
    id: "x",
    source: "ticket",
    severity: "normal",
    group: "this_week",
    title: "t",
    context: "",
    href: "/x",
    dueAt: null,
    actions: [],
    ...over,
  };
}

describe("rankNeeds", () => {
  it("orders by severity, then group, then due time", () => {
    const ranked = rankNeeds([
      item({ id: "normal-early", severity: "normal", group: "before_service", dueAt: "2026-10-09T00:00:00Z" }),
      item({ id: "soon-later", severity: "soon", group: "later" }),
      item({ id: "urgent-week", severity: "urgent", group: "this_week", dueAt: "2026-10-10T00:00:00Z" }),
      item({ id: "urgent-before-late", severity: "urgent", group: "before_service", dueAt: "2026-10-12T00:00:00Z" }),
      item({ id: "urgent-before-early", severity: "urgent", group: "before_service", dueAt: "2026-10-09T00:00:00Z" }),
      item({ id: "urgent-before-none", severity: "urgent", group: "before_service", dueAt: null }),
    ]);
    expect(ranked.map((r) => r.id)).toEqual([
      "urgent-before-early",
      "urgent-before-late",
      "urgent-before-none",
      "urgent-week",
      "soon-later",
      "normal-early",
    ]);
  });

  it("is stable for equal items and does not change the input", () => {
    const input = ["a", "b", "c", "d"].map((id) => item({ id }));
    const copy = [...input];
    expect(rankNeeds(input).map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
    expect(input).toEqual(copy);
  });

  it("treats a bad date as no due time", () => {
    const ranked = rankNeeds([item({ id: "bad", dueAt: "nonsense" }), item({ id: "ok", dueAt: "2026-10-09T00:00:00Z" })]);
    expect(ranked.map((r) => r.id)).toEqual(["ok", "bad"]);
  });

  it("handles an empty list", () => {
    expect(rankNeeds([])).toEqual([]);
  });
});

describe("groupFor", () => {
  const now = NOW.getTime();
  const start = now + 3 * 86_400_000;
  it("is before_service when due (or now) is before the next service", () => {
    expect(groupFor(null, now, start)).toBe("before_service");
    expect(groupFor(start - 1, now, start)).toBe("before_service");
    expect(groupFor(now - 1000, now, start)).toBe("before_service");
  });
  it("is this_week within 7 days otherwise, later after that", () => {
    expect(groupFor(start + 1, now, start)).toBe("this_week");
    expect(groupFor(now + 7 * 86_400_000, now, start)).toBe("this_week");
    expect(groupFor(now + 7 * 86_400_000 + 1, now, start)).toBe("later");
    expect(groupFor(null, now, null)).toBe("this_week");
  });
});

const build = (p: ReturnType<typeof primary>, unassigned: Parameters<typeof buildNeedItems>[0]["unassigned"] = []) =>
  buildNeedItems({ now: NOW, timezone: TZ, primary: p, unassigned });

describe("buildNeedItems: tickets", () => {
  it("makes a breached reply urgent", () => {
    const items = build(
      primary({ tickets: sectionOk(ticketsOk({ mine: [ticketRow({ responseBreached: true, responseDueAt: "2026-10-08T09:00:00Z" })] })) }),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "ticket:t1", source: "ticket", severity: "urgent", href: "/tickets/t1" });
    expect(items[0]!.context).toContain("overdue");
    expect(items[0]!.actions).toEqual([{ kind: "link", label: "Reply", href: "/tickets/t1" }]);
  });

  it("makes a high priority reply due within 4 hours urgent, and a normal one soon", () => {
    const high = build(
      primary({ tickets: sectionOk(ticketsOk({ mine: [ticketRow({ priority: "high", responseDueAt: "2026-10-08T14:00:00Z" })] })) }),
    );
    expect(high[0]!.severity).toBe("urgent");
    const normal = build(
      primary({ tickets: sectionOk(ticketsOk({ mine: [ticketRow({ priority: "normal", responseDueAt: "2026-10-08T14:00:00Z" })] })) }),
    );
    expect(normal[0]!.severity).toBe("soon");
    const far = build(
      primary({ tickets: sectionOk(ticketsOk({ mine: [ticketRow({ responseDueAt: "2026-10-10T14:00:00Z" })] })) }),
    );
    expect(far[0]!.severity).toBe("normal");
  });

  it("skips tickets with no response clock", () => {
    const items = build(
      primary({ tickets: sectionOk(ticketsOk({ mine: [ticketRow({ responseDueAt: null, responseBreached: false })] })) }),
    );
    expect(items).toEqual([]);
  });

  it("adds a take action for unassigned urgent tickets only when the person can assign", () => {
    const u = [{ id: "u1", number: 5, title: "Wifi down", priority: "urgent" as const }];
    const withTake = build(primary({ tickets: sectionOk(ticketsOk({ canAssign: true })) }), u);
    expect(withTake[0]!.severity).toBe("urgent");
    expect(withTake[0]!.actions[0]).toEqual({ kind: "ticket_take", label: "Take it", ticketId: "u1" });
    const without = build(primary({ tickets: sectionOk(ticketsOk({ canAssign: false })) }), u);
    expect(without[0]!.actions.map((a) => a.kind)).toEqual(["link"]);
    const high = build(primary({ tickets: sectionOk(ticketsOk({ canAssign: true })) }), [{ ...u[0]!, priority: "high" as const }]);
    expect(high[0]!.severity).toBe("soon");
  });
});

describe("buildNeedItems: systems", () => {
  it("makes an urgent item with an ack action when the person can write", () => {
    const items = build(primary({ systems: sectionOk(systemsOk({ problems: [problem()] })) }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ source: "system", severity: "urgent", title: "AP-Kids-Wing is offline" });
    expect(items[0]!.actions[0]).toEqual({ kind: "unifi_ack", label: "Acknowledge", mac: "aa:bb" });
  });

  it("leaves the ack action out for read-only people, and drops acknowledged devices", () => {
    const ro = build(primary({ systems: sectionOk(systemsOk({ canWrite: false, problems: [problem()] })) }));
    expect(ro[0]!.actions.map((a) => a.kind)).toEqual(["link"]);
    const acked = build(
      primary({ systems: sectionOk(systemsOk({ problems: [problem({ ack: { kind: "unifi", mac: "aa:bb", acked: true } })] })) }),
    );
    expect(acked).toEqual([]);
  });

  it("describes non-wifi problems and has no ack for them", () => {
    const items = build(
      primary({
        systems: sectionOk(
          systemsOk({ problems: [problem({ id: "servers:s1", area: "servers", name: "Files", detail: "timeout", ack: null, since: null })] }),
        ),
      }),
    );
    expect(items[0]!.title).toBe("Files is down");
    expect(items[0]!.context).toBe("Servers: timeout");
    expect(items[0]!.actions.map((a) => a.kind)).toEqual(["link"]);
  });
});

describe("buildNeedItems: team", () => {
  it("raises an item for an empty position and one for people who have not replied", () => {
    const items = build(primary({ service: sectionOk(serviceOk()) }));
    const ids = items.map((i) => i.id);
    expect(ids).toContain("team:declined:Bass");
    expect(ids).toContain("team:waiting");
    const bass = items.find((i) => i.id === "team:declined:Bass")!;
    expect(bass.title).toBe("Bass is empty for Sunday Gathering");
    expect(bass.group).toBe("before_service");
    expect(bass.severity).toBe("urgent");
    const waiting = items.find((i) => i.id === "team:waiting")!;
    expect(waiting.title).toBe("2 people haven't replied for Sunday Gathering");
    expect(waiting.context).toBe("Di, Ed");
  });

  it("is less severe when the service is further away, and ignores waiting beyond 7 days", () => {
    const week = build(primary({ service: sectionOk(serviceOk({ startsAt: "2026-10-14T09:00:00Z" })) }));
    expect(week.find((i) => i.id === "team:declined:Bass")!.severity).toBe("soon");
    expect(week.find((i) => i.id === "team:waiting")!.severity).toBe("soon");
    const far = build(primary({ service: sectionOk(serviceOk({ startsAt: "2026-10-30T09:00:00Z" })) }));
    expect(far.find((i) => i.id === "team:waiting")).toBeUndefined();
    expect(far.find((i) => i.id === "team:declined:Bass")).toBeDefined();
  });

  it("does not call a position empty when someone else confirmed", () => {
    const svc = serviceOk();
    svc.team!.positions[1]!.people.push({ name: "Fay", status: "confirmed", isMe: false, localUserId: null });
    expect(build(primary({ service: sectionOk(svc) })).find((i) => i.id === "team:declined:Bass")).toBeUndefined();
  });

  it("has nothing for a checklist-sourced service", () => {
    expect(build(primary({ service: sectionOk(serviceOk({ source: "checklist", team: null })) }))).toEqual([]);
  });
});

describe("buildNeedItems: checklists and gaps", () => {
  it("makes one item per event with open tasks", () => {
    const items = build(primary({ checklists: sectionOk(checklistsOk()) }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "checklist:e1", source: "checklist", group: "this_week", href: "/checklists/e1" });
    expect(items[0]!.title).toBe("2 open tasks for Sunday setup");
    expect(items[0]!.context).toBe("Lights, Mics");
    const none = build(primary({ checklists: sectionOk({ events: [] }) }));
    expect(none).toEqual([]);
  });

  it("puts things due before the service in before_service", () => {
    const items = build(primary({ service: sectionOk(serviceOk({ team: null })), checklists: sectionOk(checklistsOk()) }));
    expect(items[0]!.group).toBe("before_service");
  });

  it("returns nothing when every source is off", () => {
    expect(build(primary())).toEqual([]);
  });

  it("every item has an href", () => {
    const items = build(
      primary({
        tickets: sectionOk(ticketsOk({ mine: [ticketRow()] })),
        systems: sectionOk(systemsOk({ problems: [problem()] })),
        service: sectionOk(serviceOk()),
        checklists: sectionOk(checklistsOk()),
      }),
    );
    expect(items.length).toBeGreaterThan(3);
    for (const i of items) expect(i.href).not.toBe("");
  });
});

describe("HomeNeedsSection", () => {
  const ctx = (perms: string[]): HomeContext =>
    ({ user: { id: "u1", permissions: perms }, now: NOW, timezone: TZ, includes: new Set() }) as unknown as HomeContext;

  it("reports forbidden when every source is forbidden", async () => {
    const section = new HomeNeedsSection({} as TicketsService);
    expect(await section.build(ctx([]), primary())).toEqual({ state: "forbidden" });
  });

  it("is unavailable when sources are off for other reasons", async () => {
    const section = new HomeNeedsSection({} as TicketsService);
    const res = await section.build(ctx([]), primary({ systems: sectionOff("unavailable"), tickets: sectionOff("forbidden") }));
    expect(res.state).toBe("unavailable");
  });

  it("asks for unassigned urgent tickets only with tickets:read:any, and ranks the result", async () => {
    const calls: unknown[] = [];
    const tickets = {
      list: async (_u: unknown, q: unknown) => {
        calls.push(q);
        return [{ id: "u1", number: 9, title: "Printer", priority: "high" }];
      },
    } as unknown as TicketsService;
    const section = new HomeNeedsSection(tickets);
    const p = primary({
      tickets: sectionOk(ticketsOk({ canAssign: true })),
      systems: sectionOk(systemsOk({ problems: [problem()] })),
    });
    const res = await section.build(ctx(["tickets:read:any"]), p);
    expect(res.state).toBe("ok");
    if (res.state === "ok") expect(res.data.map((i) => i.severity)).toEqual(["urgent", "soon"]);
    expect(calls).toHaveLength(1);

    calls.length = 0;
    await section.build(ctx(["tickets:read:own"]), p);
    expect(calls).toHaveLength(0);
  });

  it("survives a failing ticket lookup", async () => {
    const tickets = {
      list: async () => {
        throw new Error("db");
      },
    } as unknown as TicketsService;
    const res = await new HomeNeedsSection(tickets).build(
      ctx(["tickets:read:any"]),
      primary({ tickets: sectionOk(ticketsOk()), systems: sectionOk(systemsOk({ problems: [problem()] })) }),
    );
    expect(res.state).toBe("ok");
  });
});
