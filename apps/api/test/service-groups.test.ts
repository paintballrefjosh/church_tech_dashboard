import { describe, expect, it } from "vitest";
import {
  commonStateMetrics,
  evaluateServiceGroup,
  groupCheckForSec,
  memberIsStale,
  roleFor,
  roleRuleProblem,
  serviceGroupRuleId,
  serviceGroupSaveSchema,
  stepGroupAlerts,
  type ServiceGroupMemberInput,
} from "@church/shared";

const NOW = new Date("2026-10-26T12:00:00Z");
const ago = (s: number) => new Date(NOW.getTime() - s * 1000).toISOString();

function m(id: string, status: ServiceGroupMemberInput["status"], over: Partial<ServiceGroupMemberInput> = {}): ServiceGroupMemberInput {
  return { id, templateKey: "keepalived", status, intervalSec: 60, lastPolledAt: ago(30), states: {}, ...over };
}

const MASTER = { metric: "role", value: "MASTER", min: 1, max: 1 };

describe("memberIsStale", () => {
  it("is stale with no reading, or one older than three intervals (3 minutes at least)", () => {
    expect(memberIsStale({ lastPolledAt: null, intervalSec: 60 }, NOW)).toBe(true);
    expect(memberIsStale({ lastPolledAt: ago(170), intervalSec: 30 }, NOW)).toBe(false);
    expect(memberIsStale({ lastPolledAt: ago(190), intervalSec: 30 }, NOW)).toBe(true);
    expect(memberIsStale({ lastPolledAt: ago(800), intervalSec: 300 }, NOW)).toBe(false);
    expect(memberIsStale({ lastPolledAt: ago(901), intervalSec: 300 }, NOW)).toBe(true);
  });
});

describe("evaluateServiceGroup", () => {
  it("everyone up is up; a degraded member still works but makes the group degraded", () => {
    expect(evaluateServiceGroup({ minHealthy: null, role: null }, [m("a", "up"), m("b", "up")], NOW).status).toBe("up");
    const r = evaluateServiceGroup({ minHealthy: null, role: null }, [m("a", "up"), m("b", "degraded")], NOW);
    expect(r.status).toBe("degraded");
    expect(r.working).toBe(2);
    expect(r.checks).toEqual([expect.objectContaining({ id: "quorum", breaching: false })]);
  });

  it("without minHealthy every member must work; with it, a loss within the quorum is only degraded", () => {
    const members = [m("a", "up"), m("b", "up"), m("c", "down")];
    const all = evaluateServiceGroup({ minHealthy: null, role: null }, members, NOW);
    expect(all.status).toBe("down");
    expect(all.checks[0]!.text).toBe("2 of 3 working (3 needed)");
    const two = evaluateServiceGroup({ minHealthy: 2, role: null }, members, NOW);
    expect(two.status).toBe("degraded");
    expect(two.checks[0]!.breaching).toBe(false);
  });

  it("a stale reading does not count as working, and a switched-off member is not counted at all", () => {
    const r = evaluateServiceGroup({ minHealthy: 2, role: null }, [m("a", "up"), m("b", "up", { lastPolledAt: ago(3600) }), m("c", "disabled")], NOW);
    expect(r.counted).toBe(2);
    expect(r.working).toBe(1);
    expect(r.memberState.b).toEqual({ working: false, stale: true, role: null });
    expect(r.memberState.c).toBeUndefined();
    expect(r.status).toBe("down");
  });

  it("asks no more members than there are (minHealthy above the count is capped)", () => {
    const r = evaluateServiceGroup({ minHealthy: 5, role: null }, [m("a", "up"), m("b", "up")], NOW);
    expect(r.status).toBe("up");
  });

  it("nobody counted is unknown with nothing to judge", () => {
    const r = evaluateServiceGroup({ minHealthy: null, role: MASTER }, [m("a", "disabled")], NOW);
    expect(r).toMatchObject({ status: "unknown", counted: 0, checks: [], roleCount: 0 });
  });

  it("counts the role among working members only, case-insensitively", () => {
    const one = evaluateServiceGroup(
      { minHealthy: 1, role: MASTER },
      [m("a", "up", { states: { role: "master" } }), m("b", "up", { states: { role: "BACKUP" } })],
      NOW,
    );
    expect(one.status).toBe("up");
    expect(one.roleCount).toBe(1);
    expect(one.checks[1]).toMatchObject({ id: "role", breaching: false, text: "1 member is MASTER (exactly 1 wanted)" });
  });

  it("no MASTER and two MASTERs (split brain) both breach", () => {
    const none = evaluateServiceGroup(
      { minHealthy: 1, role: MASTER },
      [m("a", "up", { states: { role: "BACKUP" } }), m("b", "up", { states: { role: "BACKUP" } })],
      NOW,
    );
    expect(none.status).toBe("down");
    expect(none.checks[1]).toMatchObject({ breaching: true, text: "No member is MASTER (exactly 1 wanted)" });
    const two = evaluateServiceGroup(
      { minHealthy: 1, role: MASTER },
      [m("a", "up", { states: { role: "MASTER" } }), m("b", "up", { states: { role: "MASTER" } })],
      NOW,
    );
    expect(two.checks[1]).toMatchObject({ breaching: true, text: "2 members are MASTER (exactly 1 wanted)" });
  });

  it("a down member's stale MASTER does not count, and a quorum breach silences the role check", () => {
    const r = evaluateServiceGroup(
      { minHealthy: 2, role: MASTER },
      [m("a", "down", { states: { role: "MASTER" } }), m("b", "up", { states: { role: "BACKUP" } })],
      NOW,
    );
    expect(r.roleCount).toBe(0);
    expect(r.checks.map((c) => [c.id, c.breaching])).toEqual([
      ["quorum", true],
      ["role", false],
    ]);
  });

  it("a role with no upper limit", () => {
    const r = evaluateServiceGroup(
      { minHealthy: null, role: { metric: "role", value: "standby", min: 1, max: null } },
      [m("a", "up", { states: { role: "primary" } }), m("b", "up", { states: { role: "standby" } }), m("c", "up", { states: { role: "standby" } })],
      NOW,
    );
    expect(r.checks[1]).toMatchObject({ breaching: false, text: "2 members are standby (at least 1 wanted)" });
  });
});

describe("a role across templates that name it differently", () => {
  const PRIMARY = {
    metric: "role",
    value: "primary",
    min: 1,
    max: 1,
    byTemplate: { patroni: { metric: "role", value: "leader" }, repmgr: { metric: "node_role", value: "primary" } },
  };

  it("each member is read by its own template's state and value", () => {
    expect(roleFor(PRIMARY, "patroni")).toEqual({ metric: "role", value: "leader" });
    expect(roleFor(PRIMARY, "other")).toEqual({ metric: "role", value: "primary" });
    const r = evaluateServiceGroup(
      { minHealthy: 1, role: PRIMARY },
      [
        m("a", "up", { templateKey: "patroni", states: { role: "Leader" } }),
        m("b", "up", { templateKey: "repmgr", states: { node_role: "standby", role: "primary" } }),
      ],
      NOW,
    );
    expect(r.roleCount).toBe(1);
    expect(r.memberState.b!.role).toBe("standby");
    expect(r.checks[1]).toMatchObject({ breaching: false, text: "1 member is primary (exactly 1 wanted)" });
  });

  it("two templates both claiming the role is split brain", () => {
    const r = evaluateServiceGroup(
      { minHealthy: 1, role: PRIMARY },
      [m("a", "up", { templateKey: "patroni", states: { role: "leader" } }), m("b", "up", { templateKey: "repmgr", states: { node_role: "primary" } })],
      NOW,
    );
    expect(r.checks[1]).toMatchObject({ breaching: true, text: "2 members are primary (exactly 1 wanted)" });
  });

  it("refuses a rule a template cannot report", () => {
    const templates = [
      { key: "patroni", name: "Patroni", metrics: [{ metric: "role" }] },
      { key: "repmgr", name: "repmgr", metrics: [{ metric: "node_role" }] },
    ];
    expect(roleRuleProblem(PRIMARY, templates)).toBeNull();
    expect(roleRuleProblem({ ...PRIMARY, byTemplate: { patroni: PRIMARY.byTemplate.patroni } }, templates)).toBe('"role" is not a state the repmgr template reports');
  });

  it("the schema keeps byTemplate optional, so rules saved before it still read", () => {
    expect(serviceGroupSaveSchema.parse({ name: "x", role: MASTER }).role).toEqual(MASTER);
    expect(serviceGroupSaveSchema.safeParse({ name: "x", role: { ...MASTER, byTemplate: { t: { metric: "Bad!", value: "x" } } } }).success).toBe(false);
  });
});

describe("the redundancy warning", () => {
  const three = (down: number) => ["a", "b", "c"].map((id, i) => m(id, i < down ? "down" : "up"));

  it("is only judged when asked for, breaches while a member is lost but the quorum holds", () => {
    expect(evaluateServiceGroup({ minHealthy: 2, role: null }, three(1), NOW).checks.map((c) => c.id)).toEqual(["quorum"]);
    const one = evaluateServiceGroup({ minHealthy: 2, role: null, redundancyAfterMin: 15 }, three(1), NOW);
    expect(one.status).toBe("degraded");
    expect(one.checks[1]).toEqual({ id: "redundancy", severity: "warning", breaching: true, text: "1 member is not working; 2 of 3 carry it" });
    const fine = evaluateServiceGroup({ minHealthy: 2, role: null, redundancyAfterMin: 15 }, three(0), NOW);
    expect(fine.checks[1]).toMatchObject({ breaching: false, text: "Every member working" });
    // Below the quorum the quorum check speaks instead.
    const two = evaluateServiceGroup({ minHealthy: 2, role: null, redundancyAfterMin: 15 }, three(2), NOW);
    expect(two.checks.map((c) => [c.id, c.breaching])).toEqual([
      ["quorum", true],
      ["redundancy", false],
    ]);
  });

  it("waits its own minutes, not the group's seconds", () => {
    const g = { forSec: 60, redundancyAfterMin: 15 };
    expect(groupCheckForSec(g, "quorum")).toBe(60);
    expect(groupCheckForSec(g, "redundancy")).toBe(900);
    const result = evaluateServiceGroup({ minHealthy: 2, role: null, redundancyAfterMin: 15 }, three(1), NOW);
    const hold = (c: Parameters<typeof groupCheckForSec>[1]) => groupCheckForSec(g, c);
    const a = stepGroupAlerts(result, {}, hold, NOW);
    expect(a.transitions).toEqual([]);
    expect(stepGroupAlerts(result, a.state, hold, new Date(NOW.getTime() + 600_000)).transitions).toEqual([]);
    expect(stepGroupAlerts(result, a.state, hold, new Date(NOW.getTime() + 900_000)).transitions).toEqual([{ id: "redundancy", action: "open" }]);
  });
});

describe("stepGroupAlerts", () => {
  const breach = { counted: 2, checks: [{ id: "quorum" as const, severity: "critical" as const, breaching: true, text: "x" }] };
  const fine = { counted: 2, checks: [{ id: "quorum" as const, severity: "critical" as const, breaching: false, text: "x" }] };

  it("opens only after the breach has lasted forSec, once", () => {
    const a = stepGroupAlerts(breach, {}, 60, NOW);
    expect(a.transitions).toEqual([]);
    const later = new Date(NOW.getTime() + 61_000);
    const b = stepGroupAlerts(breach, a.state, 60, later);
    expect(b.transitions).toEqual([{ id: "quorum", action: "open" }]);
    const opened = { quorum: { ...b.state.quorum!, open: true, incidentId: "i1" } };
    expect(stepGroupAlerts(breach, opened, 60, new Date(later.getTime() + 30_000)).transitions).toEqual([]);
    const c = stepGroupAlerts(fine, opened, 60, new Date(later.getTime() + 60_000));
    expect(c.transitions).toEqual([{ id: "quorum", action: "resolve" }]);
    expect(c.state.quorum).toEqual({ breachingSince: null, open: false, incidentId: null });
  });

  it("forSec 0 opens at once; a breach that clears before forSec opens nothing", () => {
    expect(stepGroupAlerts(breach, {}, 0, NOW).transitions).toEqual([{ id: "quorum", action: "open" }]);
    const a = stepGroupAlerts(breach, {}, 60, NOW);
    expect(stepGroupAlerts(fine, a.state, 60, new Date(NOW.getTime() + 30_000)).transitions).toEqual([]);
  });

  it("a rule taken away, or nobody left to judge, resolves what it had open", () => {
    const prev = { role: { breachingSince: ago(600), open: true, incidentId: "i2" } };
    expect(stepGroupAlerts(fine, prev, 60, NOW).transitions).toEqual([{ id: "role", action: "resolve" }]);
    expect(stepGroupAlerts({ counted: 0, checks: [] }, prev, 60, NOW)).toEqual({ state: {}, transitions: [{ id: "role", action: "resolve" }] });
  });

  it("rule ids", () => {
    expect(serviceGroupRuleId("quorum")).toBe("group:quorum");
  });
});

describe("serviceGroupSaveSchema", () => {
  it("fills defaults and refuses a most below the fewest", () => {
    expect(serviceGroupSaveSchema.parse({ name: " Cluster " })).toEqual({
      name: "Cluster",
      description: "",
      minHealthy: null,
      role: null,
      forSec: 60,
      alerts: true,
      instanceIds: [],
      redundancyAfterMin: null,
      showOnStatus: false,
      statusName: null,
    });
    expect(serviceGroupSaveSchema.safeParse({ name: "x", role: { metric: "role", value: "MASTER", min: 2, max: 1 } }).success).toBe(false);
    expect(serviceGroupSaveSchema.safeParse({ name: "x", role: { metric: "Role!", value: "MASTER", min: 1, max: 1 } }).success).toBe(false);
  });
});

describe("commonStateMetrics", () => {
  it("offers only state metrics every member's template has", () => {
    const keepalived = { metrics: { role: { kind: "state", label: "Role" }, priority: { kind: "gauge" } } };
    const other = { metrics: { role: { kind: "state" }, version: { kind: "state" } } };
    expect(commonStateMetrics([keepalived])).toEqual([{ metric: "role", label: "Role" }]);
    expect(commonStateMetrics([keepalived, other])).toEqual([{ metric: "role", label: "Role" }]);
    expect(commonStateMetrics([keepalived, { metrics: { priority: { kind: "gauge" } } }])).toEqual([]);
    expect(commonStateMetrics([])).toEqual([]);
  });
});
