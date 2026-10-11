import { describe, expect, it } from "vitest";
import { deadlinePhrase, sectionOk, sectionOff, summarize, type SummaryToken } from "@church/shared";
import {
  NOW,
  TZ,
  checklistsOk,
  problem,
  serviceOk,
  summaryInput,
  systemsOk,
  ticketRow,
  ticketsOk,
} from "./helpers/home-fixtures";

/** Links in [brackets], so a test reads like the sentence. */
function render(tokens: SummaryToken[]): string {
  return tokens.map((t) => (t.kind === "link" ? `[${t.text}]` : t.text)).join("");
}

describe("summarize: the whole sentence", () => {
  it("reads as the concept's example", () => {
    const out = summarize(
      summaryInput({
        systems: sectionOk(systemsOk({ problems: [problem()] })),
        service: sectionOk(serviceOk()),
        tickets: sectionOk(ticketsOk({ mine: [ticketRow()] })),
      }),
    );
    expect(render(out)).toBe(
      "Everything's running except [AP-Kids-Wing]. Sunday's team is [12 of 15] confirmed, and [#201] needs a reply by 9:40 tonight.",
    );
  });

  it("gives links hrefs and tones", () => {
    const out = summarize(
      summaryInput({
        systems: sectionOk(systemsOk({ problems: [problem()] })),
        service: sectionOk(serviceOk()),
        tickets: sectionOk(ticketsOk({ mine: [ticketRow()] })),
      }),
    );
    const links = out.filter((t): t is Extract<SummaryToken, { kind: "link" }> => t.kind === "link");
    expect(links.map((l) => [l.href, l.tone])).toEqual([
      ["/monitoring/network", "bad"],
      ["/planning-center/1/2", "bad"], // someone declined
      ["/tickets/t1", "warn"],
    ]);
  });
});

describe("summarize: systems sentence", () => {
  it("says everything is running when nothing is wrong", () => {
    expect(render(summarize(summaryInput({ systems: sectionOk(systemsOk()) })))).toBe("Everything's running.");
  });
  it("lists up to two problems and counts more", () => {
    const two = summarize(
      summaryInput({
        systems: sectionOk(systemsOk({ problems: [problem(), problem({ id: "b", name: "Files", href: "/monitoring/infra/1", area: "servers" })] })),
      }),
    );
    expect(render(two)).toBe("Everything's running except [AP-Kids-Wing] and [Files].");
    const many = summarize(
      summaryInput({
        systems: sectionOk(systemsOk({ problems: [problem({ id: "1" }), problem({ id: "2" }), problem({ id: "3" })] })),
      }),
    );
    expect(render(many)).toBe("[3 systems] are down.");
  });
  it("does not overclaim when an area could not be read", () => {
    const sys = systemsOk();
    sys.areas.push({ key: "dns", label: "DNS", href: "/dns", state: "unavailable", up: 0, down: 0, total: 0, note: "timed out" });
    expect(render(summarize(summaryInput({ systems: sectionOk(sys) })))).toBe("Everything we can reach is running.");
  });
  it("mentions maintenance mode", () => {
    expect(render(summarize(summaryInput({ systems: sectionOk(systemsOk({ maintenanceMode: true })) })))).toBe(
      "Everything's running. Alerts are paused for maintenance.",
    );
  });
  it("says nothing when nothing is monitored", () => {
    const empty = systemsOk({ areas: [], totals: { up: 0, down: 0, total: 0 } });
    expect(summarize(summaryInput({ systems: sectionOk(empty) }))).toEqual([]);
  });
});

describe("summarize: missing and forbidden sections", () => {
  it("returns nothing when every section is off", () => {
    expect(summarize(summaryInput())).toEqual([]);
    for (const state of ["forbidden", "unconfigured", "unavailable"] as const) {
      expect(
        summarize(
          summaryInput({
            systems: sectionOff(state),
            service: sectionOff(state),
            tickets: sectionOff(state),
            checklists: sectionOff(state),
          }),
        ),
      ).toEqual([]);
    }
  });

  it("never mentions a section that is off", () => {
    const text = render(summarize(summaryInput({ service: sectionOk(serviceOk()) })));
    expect(text).toBe("Sunday's team is [12 of 15] confirmed.");
    expect(text).not.toMatch(/running|ticket|checklist/i);
    expect(render(summarize(summaryInput({ tickets: sectionOk(ticketsOk({ mine: [ticketRow()] })) })))).toBe(
      "[#201] needs a reply by 9:40 tonight.",
    );
  });

  it("uses the next service when there is no team", () => {
    const out = summarize(summaryInput({ service: sectionOk(serviceOk({ source: "checklist", team: null })) }));
    expect(render(out)).toBe("Next up is [Sunday Gathering].");
  });

  it("skips an empty roster", () => {
    const svc = serviceOk();
    svc.team = { confirmed: 0, waiting: 0, declined: 0, positions: [] };
    expect(summarize(summaryInput({ service: sectionOk(svc) }))).toEqual([]);
  });
});

describe("summarize: team clause", () => {
  it("names the day relative to now", () => {
    const at = (iso: string, now: Date) =>
      render(summarize(summaryInput({ generatedAt: now.toISOString(), service: sectionOk(serviceOk({ startsAt: iso })) })));
    expect(at("2026-10-08T17:00:00Z", NOW)).toMatch(/^Today's team/);
    expect(at("2026-10-09T09:00:00Z", NOW)).toMatch(/^Tomorrow's team/);
    expect(at("2026-10-11T09:00:00Z", NOW)).toMatch(/^Sunday's team/);
    expect(at("2026-10-25T09:00:00Z", NOW)).toMatch(/^Next service's team/);
  });
  it("colours the count by how complete the team is", () => {
    const tone = (c: number, w: number, d: number) => {
      const svc = serviceOk();
      svc.team = { confirmed: c, waiting: w, declined: d, positions: [] };
      const link = summarize(summaryInput({ service: sectionOk(svc) })).find((t) => t.kind === "link");
      return link && link.kind === "link" ? link.tone : null;
    };
    expect(tone(15, 0, 0)).toBe("ok");
    expect(tone(12, 3, 0)).toBe("warn");
    expect(tone(12, 2, 1)).toBe("bad");
  });
});

describe("summarize: ticket clause", () => {
  it("prefers overdue replies", () => {
    const one = summarize(
      summaryInput({ tickets: sectionOk(ticketsOk({ mine: [ticketRow({ responseBreached: true })] })) }),
    );
    expect(render(one)).toBe("[#201] is overdue for a reply.");
    const two = summarize(
      summaryInput({
        tickets: sectionOk(ticketsOk({ mine: [ticketRow({ responseBreached: true }), ticketRow({ id: "t2", number: 202, responseBreached: true })] })),
      }),
    );
    expect(render(two)).toBe("[2 tickets] are overdue for a reply.");
  });
  it("picks the earliest reply due", () => {
    const out = summarize(
      summaryInput({
        tickets: sectionOk(
          ticketsOk({
            mine: [
              ticketRow({ number: 300, responseDueAt: "2026-10-09T10:00:00Z" }),
              ticketRow({ number: 301, responseDueAt: "2026-10-08T15:00:00Z" }),
            ],
          }),
        ),
      }),
    );
    expect(render(out)).toBe("[#301] needs a reply by 4:00 pm today.");
  });
  it("falls back to unassigned tickets, then to open ones", () => {
    expect(render(summarize(summaryInput({ tickets: sectionOk(ticketsOk({ canAssign: true, unassignedCount: 1 })) })))).toBe(
      "[1 ticket] is waiting for someone to take it.",
    );
    expect(render(summarize(summaryInput({ tickets: sectionOk(ticketsOk({ canAssign: true, unassignedCount: 3 })) })))).toBe(
      "[3 tickets] are waiting for someone to take them.",
    );
    expect(
      render(summarize(summaryInput({ tickets: sectionOk(ticketsOk({ mine: [ticketRow({ responseDueAt: null })] })) }))),
    ).toBe("You have [1 open ticket].");
  });
  it("says nothing for an empty queue", () => {
    expect(summarize(summaryInput({ tickets: sectionOk(ticketsOk()) }))).toEqual([]);
  });
});

describe("summarize: combining clauses", () => {
  it("uses at most two clauses in the second sentence, lower-casing a soft lead", () => {
    const out = summarize(
      summaryInput({
        service: sectionOk(serviceOk()),
        tickets: sectionOk(ticketsOk({ mine: [ticketRow({ responseDueAt: null })] })),
        checklists: sectionOk(checklistsOk()),
      }),
    );
    expect(render(out)).toBe("Sunday's team is [12 of 15] confirmed, and you have [1 open ticket].");
  });
  it("shows checklist tasks when nothing else competes", () => {
    expect(render(summarize(summaryInput({ checklists: sectionOk(checklistsOk()) })))).toBe(
      "You have [2 checklist tasks] to do.",
    );
    expect(render(summarize(summaryInput({ checklists: sectionOk({ events: [] }) })))).toBe("");
  });
  it("joins sentences with a space", () => {
    const out = render(
      summarize(summaryInput({ systems: sectionOk(systemsOk()), checklists: sectionOk(checklistsOk()) })),
    );
    expect(out).toBe("Everything's running. You have [2 checklist tasks] to do.");
  });
  it("defaults now to the snapshot time", () => {
    const input = summaryInput({ tickets: sectionOk(ticketsOk({ mine: [ticketRow()] })) });
    expect(render(summarize(input))).toBe(render(summarize(input, NOW)));
  });
});

describe("deadlinePhrase", () => {
  it("words the time by distance, in the zone", () => {
    expect(deadlinePhrase(new Date("2026-10-08T20:40:00Z"), NOW, TZ)).toBe("9:40 tonight");
    expect(deadlinePhrase(new Date("2026-10-08T14:15:00Z"), NOW, TZ)).toBe("3:15 pm today");
    expect(deadlinePhrase(new Date("2026-10-09T08:30:00Z"), NOW, TZ)).toBe("9:30 am tomorrow");
    expect(deadlinePhrase(new Date("2026-10-16T08:30:00Z"), NOW, TZ)).toBe("9:30 am on Friday");
    // The same instant reads differently in another zone.
    expect(deadlinePhrase(new Date("2026-10-08T20:40:00Z"), NOW, "America/Chicago")).toBe("3:40 pm today");
  });
});
