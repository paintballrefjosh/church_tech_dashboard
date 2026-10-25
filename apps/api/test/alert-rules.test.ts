import { describe, expect, it } from "vitest";
import {
  describeMinutes,
  escalationConfig,
  escalationDue,
  monitorAlertsOff,
  flapConfig,
  flapSettled,
  isFlapping,
  statusOverall,
  validateSettingValue,
  ALERT_KEYS,
} from "@church/shared";

const at = (min: number) => new Date(Date.UTC(2026, 9, 16, 12, min, 0));

describe("flap rules", () => {
  it("reads the settings with defaults and clamps", () => {
    expect(flapConfig(undefined, undefined)).toEqual({ incidents: 3, windowMin: 30 });
    expect(flapConfig("5", 45)).toEqual({ incidents: 5, windowMin: 45 });
    expect(flapConfig(-4, 0)).toEqual({ incidents: 0, windowMin: 1 });
    expect(flapConfig(1000, 99999)).toEqual({ incidents: 50, windowMin: 1440 });
    expect(flapConfig("x", null)).toEqual({ incidents: 3, windowMin: 30 });
  });

  it("flaps at the count, and never when switched off", () => {
    const c = { incidents: 3, windowMin: 30 };
    expect(isFlapping(2, c)).toBe(false);
    expect(isFlapping(3, c)).toBe(true);
    expect(isFlapping(9, { ...c, incidents: 0 })).toBe(false);
  });

  it("settles after a whole window in one state", () => {
    const c = { incidents: 3, windowMin: 30 };
    expect(flapSettled(at(0), at(29), c)).toBe(false);
    expect(flapSettled(at(0), at(30), c)).toBe(true);
  });
});

describe("escalation steps", () => {
  const cfg = escalationConfig(15, 60, "Pastors");
  const inc = (over: Partial<Parameters<typeof escalationDue>[0]> = {}) => ({
    startedAt: at(0),
    resolvedAt: null,
    acknowledgedAt: null,
    escalationLevel: 0,
    ...over,
  });

  it("does nothing before the first step is due", () => {
    expect(escalationDue(inc(), cfg, at(14))).toBeNull();
  });
  it("sends the reminder, then the group, each once", () => {
    expect(escalationDue(inc(), cfg, at(15))).toBe(1);
    expect(escalationDue(inc({ escalationLevel: 1 }), cfg, at(40))).toBeNull();
    expect(escalationDue(inc({ escalationLevel: 1 }), cfg, at(60))).toBe(2);
    expect(escalationDue(inc({ escalationLevel: 2 }), cfg, at(600))).toBeNull();
  });
  it("sends only the highest step when both are overdue", () => {
    expect(escalationDue(inc(), cfg, at(90))).toBe(2);
  });
  it("stops when acknowledged or resolved", () => {
    expect(escalationDue(inc({ acknowledgedAt: at(5) }), cfg, at(90))).toBeNull();
    expect(escalationDue(inc({ resolvedAt: at(5) }), cfg, at(90))).toBeNull();
  });
  it("leaves an old incident alone", () => {
    expect(escalationDue(inc(), cfg, new Date(at(0).getTime() + 73 * 3_600_000))).toBeNull();
  });
  it("needs a named group for the second step", () => {
    const noGroup = escalationConfig(15, 60, "  ");
    expect(noGroup.groupMin).toBe(0);
    expect(escalationDue(inc(), noGroup, at(90))).toBe(1);
  });
  it("is off at zero", () => {
    expect(escalationDue(inc(), escalationConfig(0, 0, ""), at(900))).toBeNull();
  });
  it("clamps nonsense minutes", () => {
    expect(escalationConfig("abc", -3, "G")).toEqual({ reminderMin: 0, groupMin: 0, group: "G" });
    expect(escalationConfig(99999, 99999, "G")).toEqual({ reminderMin: 1440, groupMin: 1440, group: "G" });
  });
});

describe("status roll-up", () => {
  const s = (...states: Array<"up" | "down" | "flapping" | "unknown">) => states.map((state) => ({ state }));
  it("is ok when nothing is troubled", () => expect(statusOverall(s("up", "up"))).toBe("ok"));
  it("is degraded for a minority down or any flapping", () => {
    expect(statusOverall(s("up", "up", "down"))).toBe("degraded");
    expect(statusOverall(s("up", "flapping"))).toBe("degraded");
  });
  it("is an outage when half or more are down", () => {
    expect(statusOverall(s("up", "down"))).toBe("outage");
    expect(statusOverall(s("down"))).toBe("outage");
  });
  it("is unknown with nothing known", () => {
    expect(statusOverall([])).toBe("unknown");
    expect(statusOverall(s("unknown", "unknown"))).toBe("unknown");
  });
  it("ignores unknown ones when judging the rest", () => expect(statusOverall(s("up", "unknown"))).toBe("ok"));
});

describe("describeMinutes", () => {
  it("reads like a sentence", () => {
    expect(describeMinutes(60_000)).toBe("1 minute");
    expect(describeMinutes(25 * 60_000)).toBe("25 minutes");
    expect(describeMinutes(120 * 60_000)).toBe("2 hours");
    expect(describeMinutes(135 * 60_000)).toBe("2 h 15 min");
  });
});

describe("alert settings validation", () => {
  it("accepts sane values and rejects the rest", () => {
    expect(validateSettingValue(ALERT_KEYS.flapIncidents, 3)).toBeNull();
    expect(validateSettingValue(ALERT_KEYS.flapIncidents, 51)).not.toBeNull();
    expect(validateSettingValue(ALERT_KEYS.flapWindowMin, 0)).not.toBeNull();
    expect(validateSettingValue(ALERT_KEYS.reminderAfterMin, 0)).toBeNull();
    expect(validateSettingValue(ALERT_KEYS.reminderAfterMin, 1.5)).not.toBeNull();
    expect(validateSettingValue(ALERT_KEYS.groupAfterMin, 1441)).not.toBeNull();
    expect(validateSettingValue(ALERT_KEYS.escalationGroup, "Pastors")).toBeNull();
    expect(validateSettingValue(ALERT_KEYS.statusNotice, "x".repeat(501))).not.toBeNull();
    expect(validateSettingValue(ALERT_KEYS.statusNotice, "Wi-Fi work Saturday")).toBeNull();
  });
});

describe("monitorAlertsOff", () => {
  it("is off only for an explicit false", () => {
    expect(monitorAlertsOff({ alerts: false })).toBe(true);
    expect(monitorAlertsOff({ alerts: true })).toBe(false);
    expect(monitorAlertsOff({})).toBe(false);
    expect(monitorAlertsOff(null)).toBe(false);
    expect(monitorAlertsOff({ alerts: "false" })).toBe(false);
  });
});
