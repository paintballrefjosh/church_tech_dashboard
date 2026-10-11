import { describe, expect, it } from "vitest";
import { computeReadiness, type NextService, type ReadinessInput } from "@church/shared";
import { systemsOk } from "./helpers/home-fixtures";

const person = (name: string, status: "confirmed" | "waiting" | "declined") => ({
  name,
  status,
  isMe: false,
  localUserId: null,
});

function service(team: NextService["team"]): NextService {
  return {
    source: "planning_center",
    title: "Sunday Gathering",
    seriesTitle: null,
    serviceTypeName: null,
    href: "/planning-center/1/2",
    startsAt: "2026-10-11T08:00:00Z",
    times: [],
    team,
  };
}

const empty: ReadinessInput = { systems: null, service: null, stream: null, runthrough: null, helpdesk: null };

describe("computeReadiness", () => {
  it("is empty when nothing can be checked", () => {
    expect(computeReadiness(empty)).toEqual({ score: 0, total: 0, checks: [] });
  });

  it("systems: ok when nothing is down, warns and names the problem otherwise", () => {
    const ok = computeReadiness({ ...empty, systems: systemsOk() });
    expect(ok.checks[0]).toMatchObject({ key: "systems", ok: true, detail: "13 of 13 up." });

    const bad = computeReadiness({
      ...empty,
      systems: systemsOk({
        areas: [{ key: "wifi", label: "Wi-Fi", href: "/monitoring/network", state: "ok", up: 8, down: 1, total: 9, note: null }],
        totals: { up: 12, down: 1, total: 13 },
        problems: [{ id: "p", area: "wifi", name: "Kids wing AP", detail: null, since: null, href: "/monitoring/network", ack: null }],
      }),
    });
    expect(bad.checks[0]).toMatchObject({ ok: false, detail: "12 of 13 up. Kids wing AP is down.", href: "/monitoring/network" });
    expect(bad.score).toBe(0);
  });

  it("team: declined fails and names the position, waiting is mentioned, no team omits the check", () => {
    const team = {
      confirmed: 12,
      waiting: 2,
      declined: 1,
      positions: [
        { name: "Bass", people: [person("Tom", "declined")] },
        { name: "Vocals", people: [person("Dan", "waiting"), person("Priya", "waiting")] },
      ],
    };
    const r = computeReadiness({ ...empty, service: service(team) });
    expect(r.checks[0]).toMatchObject({
      key: "team",
      ok: false,
      detail: "12 of 15 confirmed. 2 still to reply. Bass declined.",
      href: "/planning-center/1/2",
    });
    const fine = computeReadiness({
      ...empty,
      service: service({ confirmed: 3, waiting: 1, declined: 0, positions: [] }),
    });
    expect(fine.checks[0]).toMatchObject({ ok: true, detail: "3 of 4 confirmed. 1 still to reply." });
    expect(computeReadiness({ ...empty, service: service(null) }).total).toBe(0);
  });

  it("stream: omitted when unset, ok when all up, fails naming the down ones", () => {
    expect(computeReadiness({ ...empty, stream: { monitors: [] } }).total).toBe(0);
    const up = computeReadiness({
      ...empty,
      stream: { monitors: [{ id: "1", name: "nplife.com", up: true }, { id: "2", name: "Fiber", up: true }] },
    });
    expect(up.checks[0]).toMatchObject({ ok: true, detail: "nplife.com and Fiber are up." });
    const down = computeReadiness({
      ...empty,
      stream: { monitors: [{ id: "1", name: "nplife.com", up: true }, { id: "2", name: "Fiber", up: false }] },
    });
    expect(down.checks[0]).toMatchObject({ ok: false, detail: "Fiber is down." });
  });

  it("run-through: ok when every task is done, otherwise counts; none or empty omits", () => {
    const ok = computeReadiness({ ...empty, runthrough: { name: "Wednesday Practice", done: 6, total: 6, href: "/checklists/e" } });
    expect(ok.checks[0]).toMatchObject({ ok: true, detail: "Wednesday Practice signed off by every station." });
    const part = computeReadiness({ ...empty, runthrough: { name: "Wednesday Practice", done: 3, total: 6, href: "/checklists/e" } });
    expect(part.checks[0]).toMatchObject({ ok: false, detail: "Wednesday Practice: 3 of 6 tasks done." });
    expect(computeReadiness({ ...empty, runthrough: { name: "x", done: 0, total: 0, href: "/c" } }).total).toBe(0);
  });

  it("help desk: ok with none past response time; one or many otherwise", () => {
    expect(computeReadiness({ ...empty, helpdesk: { breached: [] } }).checks[0]).toMatchObject({ ok: true });
    const one = computeReadiness({ ...empty, helpdesk: { breached: [{ number: 201, title: "x", href: "/tickets/a" }] } });
    expect(one.checks[0]).toMatchObject({ ok: false, detail: "#201 is past its response time.", href: "/tickets/a" });
    const two = computeReadiness({
      ...empty,
      helpdesk: { breached: [{ number: 1, title: "a", href: "/tickets/a" }, { number: 2, title: "b", href: "/tickets/b" }] },
    });
    expect(two.checks[0]).toMatchObject({ ok: false, href: "/tickets" });
  });

  it("score counts ok checks out of the checks shown", () => {
    const r = computeReadiness({
      systems: systemsOk(),
      service: service({ confirmed: 1, waiting: 0, declined: 1, positions: [{ name: "Bass", people: [person("T", "declined")] }] }),
      stream: null,
      runthrough: { name: "R", done: 1, total: 1, href: "/c" },
      helpdesk: { breached: [] },
    });
    expect(r.total).toBe(4);
    expect(r.score).toBe(3);
    expect(r.checks.map((c) => c.key)).toEqual(["systems", "team", "runthrough", "helpdesk"]);
  });
});
