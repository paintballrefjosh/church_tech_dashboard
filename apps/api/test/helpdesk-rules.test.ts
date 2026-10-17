import { describe, expect, it } from "vitest";
import {
  SLA_ALERT_STALE_MS,
  renderCannedReply,
  slaAlertsDue,
  slaWarnPercent,
  statusAfterRequesterReply,
  ticketSlaElapsedMs,
  ticketSlaStatus,
  validateSettingValue,
  waitingTransition,
  type SlaFlags,
  type TicketSlaMap,
} from "@church/shared";

const T0 = Date.UTC(2026, 9, 17, 9, 0, 0);
const at = (min: number) => new Date(T0 + min * 60_000);
const iso = (min: number) => at(min).toISOString();

const MAP: TicketSlaMap = {
  low: { responseMin: 0, resolutionMin: 0 },
  normal: { responseMin: 100, resolutionMin: 1000 },
  high: { responseMin: 60, resolutionMin: 600 },
  urgent: { responseMin: 30, resolutionMin: 120 },
};
const NO_FLAGS: SlaFlags = { responseWarned: false, responseBreached: false, resolutionWarned: false, resolutionBreached: false };

const ticket = (over: Partial<Parameters<typeof slaAlertsDue>[0]> = {}): Parameters<typeof slaAlertsDue>[0] => ({
  priority: "normal",
  status: "open",
  createdAt: iso(0),
  firstResponseAt: null,
  waitingSince: null,
  waitedMs: 0,
  ...over,
});

describe("waiting on the requester", () => {
  const base = { status: "open" as const, waitingSince: null, waitedMs: 0 };

  it("starts the pause when a ticket starts waiting", () => {
    expect(waitingTransition(base, "waiting", at(10))).toEqual({ waitingSince: at(10), waitedMs: 0 });
  });

  it("adds the wait to the total when it ends, whatever the next status is", () => {
    const waiting = { status: "waiting" as const, waitingSince: at(10), waitedMs: 5 * 60_000 };
    expect(waitingTransition(waiting, "in_progress", at(40))).toEqual({ waitingSince: null, waitedMs: 35 * 60_000 });
    expect(waitingTransition(waiting, "resolved", at(40))).toEqual({ waitingSince: null, waitedMs: 35 * 60_000 });
  });

  it("keeps the original start when asked to wait again", () => {
    const waiting = { status: "waiting" as const, waitingSince: at(10), waitedMs: 0 };
    expect(waitingTransition(waiting, "waiting", at(40))).toEqual({ waitingSince: at(10), waitedMs: 0 });
  });

  it("leaves a ticket that never waited alone", () => {
    expect(waitingTransition({ ...base, waitedMs: 7 }, "in_progress", at(5))).toEqual({ waitingSince: null, waitedMs: 7 });
  });

  it("puts a waiting ticket back to work on a reply, and touches no other", () => {
    expect(statusAfterRequesterReply("waiting", true)).toBe("in_progress");
    expect(statusAfterRequesterReply("waiting", false)).toBe("open");
    expect(statusAfterRequesterReply("open", true)).toBe("open");
    expect(statusAfterRequesterReply("resolved", true)).toBe("resolved");
  });
});

describe("SLA clocks pause while waiting", () => {
  it("does not count finished waits or the wait in progress", () => {
    expect(ticketSlaElapsedMs({ createdAt: iso(0), waitedMs: 20 * 60_000 }, at(100))).toBe(80 * 60_000);
    expect(ticketSlaElapsedMs({ createdAt: iso(0), waitingSince: iso(60) }, at(100))).toBe(60 * 60_000);
    expect(ticketSlaElapsedMs({ createdAt: iso(0), waitedMs: 999 * 60_000 }, at(10))).toBe(0);
  });

  it("is not breached after a long wait that would otherwise have breached", () => {
    const t = { priority: "urgent" as const, createdAt: iso(0), firstResponseAt: null, status: "waiting" as const, resolvedAt: null };
    expect(ticketSlaStatus(t, MAP, at(600)).resolutionBreached).toBe(true);
    expect(ticketSlaStatus({ ...t, waitingSince: iso(10) }, MAP, at(600)).resolutionBreached).toBe(false);
  });
});

describe("SLA notices", () => {
  it("reads the warn percentage with defaults and clamps", () => {
    expect(slaWarnPercent(undefined)).toBe(80);
    expect(slaWarnPercent("50")).toBe(50);
    expect(slaWarnPercent(0)).toBe(0);
    expect(slaWarnPercent(500)).toBe(95);
    expect(slaWarnPercent(-3)).toBe(0);
    expect(slaWarnPercent("x")).toBe(80);
  });

  it("warns at the percentage, breaches past the target, in that order", () => {
    expect(slaAlertsDue(ticket(), MAP, 80, NO_FLAGS, at(79))).toEqual([]);
    expect(slaAlertsDue(ticket(), MAP, 80, NO_FLAGS, at(80))).toEqual([{ clock: "response", level: "warn", stale: false, targetMin: 100 }]);
    expect(slaAlertsDue(ticket(), MAP, 80, NO_FLAGS, at(101))).toEqual([{ clock: "response", level: "breach", stale: false, targetMin: 100 }]);
  });

  it("sends each notice once", () => {
    expect(slaAlertsDue(ticket(), MAP, 80, { ...NO_FLAGS, responseWarned: true }, at(90))).toEqual([]);
    expect(slaAlertsDue(ticket(), MAP, 80, { ...NO_FLAGS, responseWarned: true, responseBreached: true }, at(500))).toEqual([]);
  });

  it("stops the response clock at the first response, but not the resolution clock", () => {
    const t = ticket({ firstResponseAt: iso(5) });
    expect(slaAlertsDue(t, MAP, 80, NO_FLAGS, at(150))).toEqual([]);
    expect(slaAlertsDue(t, MAP, 80, NO_FLAGS, at(900))).toEqual([{ clock: "resolution", level: "warn", stale: false, targetMin: 1000 }]);
  });

  it("gives both clocks their own notice", () => {
    const out = slaAlertsDue(ticket({ priority: "urgent" }), MAP, 80, NO_FLAGS, at(31));
    // 31 minutes: past the 30 minute response target; the 120 minute resolution target is at 26%, not yet at 80%.
    expect(out.map((a) => `${a.clock}:${a.level}`)).toEqual(["response:breach"]);
    const later = slaAlertsDue(ticket({ priority: "urgent", firstResponseAt: iso(5) }), MAP, 80, NO_FLAGS, at(100));
    expect(later.map((a) => `${a.clock}:${a.level}`)).toEqual(["resolution:warn"]);
  });

  it("says nothing for a waiting, resolved or closed ticket, a disabled clock, or warnings switched off", () => {
    expect(slaAlertsDue(ticket({ status: "waiting" }), MAP, 80, NO_FLAGS, at(5000))).toEqual([]);
    expect(slaAlertsDue(ticket({ status: "resolved" }), MAP, 80, NO_FLAGS, at(5000))).toEqual([]);
    expect(slaAlertsDue(ticket({ status: "closed" }), MAP, 80, NO_FLAGS, at(5000))).toEqual([]);
    expect(slaAlertsDue(ticket({ priority: "low" }), MAP, 80, NO_FLAGS, at(5000))).toEqual([]);
    expect(slaAlertsDue(ticket(), MAP, 0, NO_FLAGS, at(90))).toEqual([]);
    expect(slaAlertsDue(ticket(), MAP, 0, NO_FLAGS, at(101))).toHaveLength(1);
  });

  it("does not count time spent waiting", () => {
    const t = ticket({ waitedMs: 50 * 60_000 });
    expect(slaAlertsDue(t, MAP, 80, NO_FLAGS, at(120))).toEqual([]);
    expect(slaAlertsDue(t, MAP, 80, NO_FLAGS, at(130))).toHaveLength(1);
  });

  it("marks a notice noticed far too late as stale", () => {
    const late = 100 + SLA_ALERT_STALE_MS / 60_000 + 1;
    expect(slaAlertsDue(ticket(), MAP, 80, NO_FLAGS, at(late))[0]).toMatchObject({ level: "breach", stale: true });
    expect(slaAlertsDue(ticket(), MAP, 80, NO_FLAGS, at(101))[0]).toMatchObject({ level: "breach", stale: false });
  });
});

describe("canned replies", () => {
  const vars = { requester: "Ana", agent: "Sam", ticket_number: "42", ticket_title: "Projector" };

  it("fills the placeholders, with or without spaces", () => {
    expect(renderCannedReply("Hi {{requester}}, it is {{ agent }} about #{{ticket_number}} ({{ticket_title}}).", vars)).toBe(
      "Hi Ana, it is Sam about #42 (Projector).",
    );
  });

  it("leaves unknown and empty placeholders as written", () => {
    expect(renderCannedReply("Hi {{requester}}, {{colour}}", { requester: "  " })).toBe("Hi {{requester}}, {{colour}}");
    expect(renderCannedReply("no placeholders", vars)).toBe("no placeholders");
  });

  it("does not expand a placeholder that a value contains", () => {
    expect(renderCannedReply("{{requester}}", { requester: "{{agent}}", agent: "Sam" })).toBe("{{agent}}");
  });
});

describe("the warn setting", () => {
  it("accepts 0 to 95 and nothing else", () => {
    expect(validateSettingValue("tickets.sla.warn_percent", 80)).toBeNull();
    expect(validateSettingValue("tickets.sla.warn_percent", 0)).toBeNull();
    expect(validateSettingValue("tickets.sla.warn_percent", 96)).not.toBeNull();
    expect(validateSettingValue("tickets.sla.warn_percent", 12.5)).not.toBeNull();
    expect(validateSettingValue("tickets.sla.warn_percent", "80")).not.toBeNull();
  });
});
