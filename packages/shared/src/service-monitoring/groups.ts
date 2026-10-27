import { z } from "zod";
import type { ServiceInstanceStatus } from "./api";
import type { CheckAlertState, CheckTransition } from "./engine";

/**
 * Service groups (docs/service-monitoring.md section 0, "Service groups"): services on DIFFERENT hosts that make one thing
 * (a CockroachDB cluster, a HAProxy + keepalived pair, a PostgreSQL primary and its standbys). Each member is still judged
 * by its own template on its own host; a group adds what only shows across hosts:
 *
 * - **quorum**: at least `minHealthy` members are working (up or degraded, read recently). Unset = every member.
 * - **role**: how many working members report a state metric with a value (`role` = `MASTER`), between `min` and `max`.
 *   No MASTER, or two (split brain), is a failure no single host can see.
 *
 * A breach that lasts `forSec` opens a normal `monitor_incident` on the group (`service_group_id`, rule `group:<check>`),
 * so acknowledging, escalation, alert channels and maintenance mode apply. Pure; the API's `service-groups` job applies it.
 */

export const serviceGroupRoleSchema = z
  .object({
    /** A state metric of the members' template(s), such as `role`. */
    metric: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/, "a metric key"),
    value: z.string().trim().min(1).max(100),
    min: z.number().int().min(0).max(100),
    /** Null = no upper limit. */
    max: z.number().int().min(0).max(100).nullable(),
  })
  .refine((r) => r.max === null || r.max >= r.min, { message: "the most cannot be below the fewest", path: ["max"] });
export type ServiceGroupRole = z.infer<typeof serviceGroupRoleSchema>;

export const serviceGroupSaveSchema = z.object({
  name: z.string().trim().min(1, "A name is needed").max(100),
  description: z.string().max(500).default(""),
  /** Null = every member must be working. */
  minHealthy: z.number().int().min(1).max(100).nullable().default(null),
  role: serviceGroupRoleSchema.nullable().default(null),
  forSec: z.number().int().min(0).max(3600).default(60),
  /** False = the group's own incidents are recorded but tell nobody (like a monitor's "Send alerts"). */
  alerts: z.boolean().default(true),
  /** The services in the group (each may be in one group; adding one here moves it out of another). */
  instanceIds: z.array(z.string().uuid()).max(100).default([]),
});
export type ServiceGroupSave = z.infer<typeof serviceGroupSaveSchema>;

export type ServiceGroupStatus = "unknown" | "up" | "degraded" | "down";
export const SERVICE_GROUP_CHECKS = ["quorum", "role"] as const;
export type ServiceGroupCheckId = (typeof SERVICE_GROUP_CHECKS)[number];

/** What the group rules read of one member. */
export interface ServiceGroupMemberInput {
  id: string;
  status: ServiceInstanceStatus;
  intervalSec: number;
  lastPolledAt: string | null;
  states: Record<string, string | null>;
}

export interface ServiceGroupCheck {
  id: ServiceGroupCheckId;
  severity: "critical";
  breaching: boolean;
  text: string;
}

export interface ServiceGroupResult {
  status: ServiceGroupStatus;
  /** Members counted (a switched-off service, or one on a switched-off host, is not). */
  counted: number;
  working: number;
  /** Working members holding the role value; null without a role rule. */
  roleCount: number | null;
  /** Per member: working, and the role value it reports. */
  memberState: Record<string, { working: boolean; stale: boolean; role: string | null }>;
  checks: ServiceGroupCheck[];
}

/** A reading older than this many of the member's intervals (and 3 minutes at least) does not count as working. */
export const GROUP_STALE_INTERVALS = 3;
const MIN_STALE_MS = 180_000;

export function memberIsStale(m: Pick<ServiceGroupMemberInput, "lastPolledAt" | "intervalSec">, now: Date): boolean {
  if (!m.lastPolledAt) return true;
  const age = now.getTime() - Date.parse(m.lastPolledAt);
  return !(age <= Math.max(MIN_STALE_MS, m.intervalSec * 1000 * GROUP_STALE_INTERVALS));
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function evaluateServiceGroup(
  group: Pick<ServiceGroupSave, "minHealthy" | "role">,
  members: readonly ServiceGroupMemberInput[],
  now: Date,
): ServiceGroupResult {
  const memberState: ServiceGroupResult["memberState"] = {};
  let counted = 0;
  let working = 0;
  let allUp = true;
  let roleCount = 0;
  for (const m of members) {
    if (m.status === "disabled") continue;
    counted++;
    const stale = memberIsStale(m, now);
    const ok = !stale && (m.status === "up" || m.status === "degraded");
    const role = group.role ? (m.states[group.role.metric] ?? null) : null;
    memberState[m.id] = { working: ok, stale, role };
    if (ok) working++;
    if (!ok || m.status !== "up") allUp = false;
    if (ok && group.role && role !== null && role.toLowerCase() === group.role.value.toLowerCase()) roleCount++;
  }

  const checks: ServiceGroupCheck[] = [];
  if (counted === 0) return { status: "unknown", counted, working, roleCount: group.role ? 0 : null, memberState, checks };

  const need = Math.min(group.minHealthy ?? counted, counted);
  const quorumBreach = working < need;
  checks.push({
    id: "quorum",
    severity: "critical",
    breaching: quorumBreach,
    text: quorumBreach
      ? `${working} of ${counted} working (${need} needed)`
      : `${working} of ${counted} working`,
  });

  let roleBreach = false;
  if (group.role) {
    const r = group.role;
    // With too few members working the quorum check speaks; "no MASTER" on top of it would say the same thing twice.
    roleBreach = !quorumBreach && (roleCount < r.min || (r.max !== null && roleCount > r.max));
    const want = r.max === null ? `at least ${r.min}` : r.min === r.max ? `exactly ${r.min}` : `${r.min} to ${r.max}`;
    checks.push({
      id: "role",
      severity: "critical",
      breaching: roleBreach,
      text:
        roleCount === 0
          ? `No member is ${r.value} (${want} wanted)`
          : `${plural(roleCount, "member is", "members are")} ${r.value} (${want} wanted)`,
    });
  }

  const status: ServiceGroupStatus = quorumBreach || roleBreach ? "down" : allUp ? "up" : "degraded";
  return { status, counted, working, roleCount: group.role ? roleCount : null, memberState, checks };
}

/** The incident rule id of a group check (`monitor_incidents.rule_id`, with `service_group_id` set). */
export const serviceGroupRuleId = (check: ServiceGroupCheckId) => `group:${check}`;

/**
 * One evaluation's step of the group's alert state: the same rule as a service's checks (`stepCheckAlerts`). A group with
 * nobody counted judges nothing (all switched off): what it had open is resolved.
 */
export function stepGroupAlerts(
  result: Pick<ServiceGroupResult, "checks" | "counted">,
  prev: Record<string, CheckAlertState>,
  forSec: number,
  now: Date,
): { state: Record<string, CheckAlertState>; transitions: CheckTransition[] } {
  const state: Record<string, CheckAlertState> = {};
  const transitions: CheckTransition[] = [];
  const present = new Set(result.checks.map((c) => c.id));
  for (const [id, s] of Object.entries(prev)) {
    // A rule taken off the group (or nobody left to judge): close what it opened.
    if (!present.has(id as ServiceGroupCheckId)) {
      if (s.open) transitions.push({ id, action: "resolve" });
      continue;
    }
    state[id] = s;
  }
  for (const c of result.checks) {
    const s: CheckAlertState = state[c.id] ?? { breachingSince: null, open: false, incidentId: null };
    if (c.breaching) {
      const since = s.breachingSince ?? now.toISOString();
      const held = (now.getTime() - Date.parse(since)) / 1000;
      if (!s.open && held >= forSec) transitions.push({ id: c.id, action: "open" });
      state[c.id] = { ...s, breachingSince: since };
    } else {
      if (s.open) transitions.push({ id: c.id, action: "resolve" });
      state[c.id] = { breachingSince: null, open: false, incidentId: null };
    }
  }
  return { state, transitions };
}

export interface ServiceGroupMember {
  id: string;
  name: string;
  targetId: string;
  targetName: string;
  templateKey: string;
  templateName: string;
  status: ServiceInstanceStatus;
  lastPolledAt: string | null;
  working: boolean;
  stale: boolean;
  role: string | null;
}

export interface ServiceGroup {
  id: string;
  name: string;
  description: string;
  minHealthy: number | null;
  role: ServiceGroupRole | null;
  forSec: number;
  alerts: boolean;
  status: ServiceGroupStatus;
  counted: number;
  working: number;
  roleCount: number | null;
  checks: Array<ServiceGroupCheck & { open: boolean }>;
  members: ServiceGroupMember[];
  lastEvaluatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The state metrics a group could use as its role, from its members' templates: `{metric, label}` for each `kind: state`
 * metric every member's template has (so the rule means the same on every member).
 */
export function commonStateMetrics(
  bodies: ReadonlyArray<{ metrics: Record<string, { kind?: string; label?: string }> }>,
): Array<{ metric: string; label: string }> {
  if (!bodies.length) return [];
  const [first, ...rest] = bodies;
  return Object.entries(first!.metrics)
    .filter(([k, m]) => m.kind === "state" && rest.every((b) => b.metrics[k]?.kind === "state"))
    .map(([k, m]) => ({ metric: k, label: m.label ?? k }));
}
