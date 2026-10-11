import type { NextService, Readiness, SystemsHealth } from "./home";

type Check = Readiness["checks"][number];

export interface ReadinessInput {
  /** Null when the person cannot see systems (or the section failed): the check is left out. */
  systems: SystemsHealth | null;
  /** The next service; its team drives the Team check. Null or without a team: left out. */
  service: NextService | null;
  /** Monitors named by `dashboard.stream_monitor_ids`. Null when none are configured (or visible). */
  stream: { monitors: readonly { id: string; name: string; up: boolean }[] } | null;
  /** The latest checklist event in the week before the service. Null when there is none. */
  runthrough: { name: string; done: number; total: number; href: string } | null;
  /** Urgent or high tickets past their response time. Null when the person cannot see tickets. */
  helpdesk: { breached: readonly { number: number; title: string; href: string }[] } | null;
}

function andList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function systemsCheck(s: SystemsHealth): Check {
  const down = s.areas.reduce((n, a) => n + (a.state === "ok" ? a.down : 0), 0);
  const ok = down === 0;
  let detail = `${s.totals.up} of ${s.totals.total} up.`;
  if (!ok) {
    const first = s.problems[0];
    if (first) {
      const more = s.problems.length - 1;
      detail += ` ${first.name}${more > 0 ? ` and ${more} more` : ""} ${s.problems.length === 1 ? "is" : "are"} down.`;
    } else detail += ` ${down} ${down === 1 ? "is" : "are"} down.`;
  }
  return { key: "systems", label: "Systems", ok, detail, href: s.problems[0]?.href ?? "/monitoring" };
}

function teamCheck(service: NextService): Check | null {
  const team = service.team;
  if (!team) return null;
  const total = team.confirmed + team.waiting + team.declined;
  if (total === 0) return null;
  const declinedPositions: string[] = [];
  for (const pos of team.positions) {
    if (pos.people.some((p) => p.status === "declined")) declinedPositions.push(pos.name);
  }
  let detail = `${team.confirmed} of ${total} confirmed.`;
  if (team.waiting > 0) detail += ` ${team.waiting} still to reply.`;
  if (team.declined > 0) detail += ` ${andList(declinedPositions)} declined.`;
  return { key: "team", label: "Team", ok: team.declined === 0, detail, href: service.href };
}

function streamCheck(stream: NonNullable<ReadinessInput["stream"]>): Check | null {
  if (stream.monitors.length === 0) return null;
  const down = stream.monitors.filter((m) => !m.up).map((m) => m.name);
  const ok = down.length === 0;
  const detail = ok
    ? `${andList(stream.monitors.map((m) => m.name))} ${stream.monitors.length === 1 ? "is" : "are"} up.`
    : `${andList(down)} ${down.length === 1 ? "is" : "are"} down.`;
  return { key: "stream", label: "Stream", ok, detail, href: "/monitoring" };
}

function runthroughCheck(r: NonNullable<ReadinessInput["runthrough"]>): Check | null {
  if (r.total <= 0) return null;
  const ok = r.done >= r.total;
  const detail = ok ? `${r.name} signed off by every station.` : `${r.name}: ${r.done} of ${r.total} tasks done.`;
  return { key: "runthrough", label: "Run-through", ok, detail, href: r.href };
}

function helpdeskCheck(h: NonNullable<ReadinessInput["helpdesk"]>): Check {
  const n = h.breached.length;
  const first = h.breached[0];
  if (n === 0 || !first) {
    return { key: "helpdesk", label: "Help desk", ok: true, detail: "No urgent or high ticket is waiting too long.", href: "/tickets" };
  }
  const detail =
    n === 1
      ? `#${first.number} is past its response time.`
      : `${n} urgent or high tickets are past their response time.`;
  return { key: "helpdesk", label: "Help desk", ok: false, detail, href: n === 1 ? first.href : "/tickets" };
}

/** Ready-for-Sunday checks. A check whose source is missing is left out; the score is out of what remains. */
export function computeReadiness(input: ReadinessInput): Readiness {
  const checks: Check[] = [];
  if (input.systems) checks.push(systemsCheck(input.systems));
  if (input.service) {
    const t = teamCheck(input.service);
    if (t) checks.push(t);
  }
  if (input.stream) {
    const s = streamCheck(input.stream);
    if (s) checks.push(s);
  }
  if (input.runthrough) {
    const r = runthroughCheck(input.runthrough);
    if (r) checks.push(r);
  }
  if (input.helpdesk) checks.push(helpdeskCheck(input.helpdesk));
  return { score: checks.filter((c) => c.ok).length, total: checks.length, checks };
}
