import { Injectable, Logger } from "@nestjs/common";
import {
  PERMISSIONS,
  deadlinePhrase,
  formatTimeInZone,
  formatWeekdayInZone,
  rankNeeds,
  calendarDaysBetween,
  sectionOff,
  sectionOk,
  type NeedItem,
  type Section,
} from "@church/shared";
import { TicketsService } from "../../../tickets/tickets.service";
import { asPriority } from "../names";
import type { DerivedSectionBuilder, HomeContext, PrimarySections } from "../home.types";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** An unassigned high or urgent ticket, for people who can read every ticket. */
export interface UnassignedTicket {
  id: string;
  number: number;
  title: string;
  priority: "low" | "normal" | "high" | "urgent";
}

export interface NeedsInput {
  now: Date;
  timezone: string;
  primary: PrimarySections;
  unassigned: readonly UnassignedTicket[];
}

/** before_service: due (or now) is before the next service starts; else this_week within 7 days; else later. */
export function groupFor(dueMs: number | null, nowMs: number, serviceStartMs: number | null): NeedItem["group"] {
  const ref = dueMs ?? nowMs;
  if (serviceStartMs !== null && ref < serviceStartMs) return "before_service";
  if (ref - nowMs <= 7 * DAY) return "this_week";
  return "later";
}

function sinceText(since: string | null, now: Date, tz: string): string {
  if (!since) return "";
  const d = new Date(since);
  if (Number.isNaN(d.getTime())) return "";
  const days = calendarDaysBetween(d, now, tz);
  return days <= 0 ? ` since ${formatTimeInZone(d, tz)}` : ` since ${formatWeekdayInZone(d, tz)}`;
}

function listNames(names: string[], max = 3): string {
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}

/** Everything that needs the person, unranked. Pure: the builder below only fetches. */
export function buildNeedItems({ now, timezone: tz, primary, unassigned }: NeedsInput): NeedItem[] {
  const nowMs = now.getTime();
  const items: NeedItem[] = [];

  const serviceStartMs =
    primary.service.state === "ok" && primary.service.data.startsAt
      ? Date.parse(primary.service.data.startsAt)
      : null;
  const startMs = serviceStartMs !== null && !Number.isNaN(serviceStartMs) ? serviceStartMs : null;
  const group = (due: number | null) => groupFor(due, nowMs, startMs);
  // Things about the service itself are due "by the service": before it, while it is still ahead.
  const forService = (): NeedItem["group"] => (startMs !== null && startMs > nowMs ? "before_service" : group(startMs));

  // (a) tickets
  if (primary.tickets.state === "ok") {
    const t = primary.tickets.data;
    for (const x of t.mine) {
      if (!x.responseBreached && !x.responseDueAt) continue;
      const dueMs = x.responseDueAt ? Date.parse(x.responseDueAt) : null;
      const left = dueMs === null ? null : dueMs - nowMs;
      let severity: NeedItem["severity"] = "normal";
      if (x.responseBreached) severity = "urgent";
      else if (left !== null && (x.priority === "urgent" || x.priority === "high") && left <= 4 * HOUR) severity = "urgent";
      else if (left !== null && left <= DAY) severity = "soon";
      const phrase = x.responseDueAt ? deadlinePhrase(new Date(x.responseDueAt), now, tz) : "";
      const from = x.requesterName ? `, from ${x.requesterName}` : "";
      items.push({
        id: `ticket:${x.id}`,
        source: "ticket",
        severity,
        group: group(dueMs),
        title: `#${x.number} ${x.title}`,
        context: x.responseBreached ? `Reply overdue (was due ${phrase})${from}` : `Reply due by ${phrase}${from}`,
        href: x.href,
        dueAt: x.responseDueAt,
        actions: [{ kind: "link", label: "Reply", href: x.href }],
      });
    }
    for (const u of unassigned) {
      const href = `/tickets/${u.id}`;
      items.push({
        id: `ticket:${u.id}`,
        source: "ticket",
        severity: u.priority === "urgent" ? "urgent" : "soon",
        group: group(null),
        title: `#${u.number} ${u.title}`,
        context: `Unassigned, ${u.priority} priority`,
        href,
        dueAt: null,
        actions: [
          ...(t.canAssign ? [{ kind: "ticket_take" as const, label: "Take it", ticketId: u.id }] : []),
          { kind: "link" as const, label: "Open", href },
        ],
      });
    }
  }

  // (b) systems problems; an acknowledged device is, by definition, known about
  if (primary.systems.state === "ok") {
    const s = primary.systems.data;
    const labels = new Map(s.areas.map((a) => [a.key, a.label]));
    for (const p of s.problems) {
      if (p.ack?.acked) continue;
      const verb = p.area === "wifi" ? "offline" : "down";
      const detail = p.detail ? `: ${p.detail}` : "";
      const actions: NeedItem["actions"] = [];
      if (p.ack && s.canWrite) actions.push({ kind: "unifi_ack", label: "Acknowledge", mac: p.ack.mac });
      actions.push({ kind: "link", label: "Open", href: p.href });
      items.push({
        id: `system:${p.id}`,
        source: "system",
        severity: "urgent",
        group: group(p.since ? Date.parse(p.since) : null),
        title: `${p.name} is ${verb}`,
        context: `${labels.get(p.area) ?? p.area}${detail}${sinceText(p.since, now, tz)}`,
        href: p.href,
        dueAt: null,
        actions,
      });
    }
  }

  // (c) the team for the next service
  if (primary.service.state === "ok" && primary.service.data.team) {
    const svc = primary.service.data;
    const team = svc.team!;
    const daysAway = startMs === null ? null : (startMs - nowMs) / DAY;
    const dueAt = svc.startsAt;
    const openAction: NeedItem["actions"] = [{ kind: "link", label: "Open plan", href: svc.href }];

    for (const pos of team.positions) {
      const declined = pos.people.filter((x) => x.status === "declined");
      if (declined.length === 0 || pos.people.some((x) => x.status === "confirmed")) continue;
      items.push({
        id: `team:declined:${pos.name}`,
        source: "team",
        severity: daysAway !== null && daysAway <= 3 ? "urgent" : "soon",
        group: forService(),
        title: `${pos.name} is empty for ${svc.title}`,
        context: `${listNames(declined.map((x) => x.name))} declined`,
        href: svc.href,
        dueAt,
        actions: openAction,
      });
    }

    const waiting = team.positions.flatMap((p) => p.people.filter((x) => x.status === "waiting"));
    if (waiting.length > 0 && daysAway !== null && daysAway <= 7) {
      items.push({
        id: "team:waiting",
        source: "team",
        severity: daysAway <= 2 ? "urgent" : "soon",
        group: forService(),
        title: `${waiting.length} ${waiting.length === 1 ? "person hasn't" : "people haven't"} replied for ${svc.title}`,
        context: listNames(waiting.map((x) => x.name)),
        href: svc.href,
        dueAt,
        actions: openAction,
      });
    }
  }

  // (d) checklists
  if (primary.checklists.state === "ok") {
    for (const ev of primary.checklists.data.events) {
      const open = ev.tasks.filter((t) => !t.done);
      if (open.length === 0) continue;
      const dueMs = ev.scheduledAt ? Date.parse(ev.scheduledAt) : null;
      const left = dueMs === null ? null : dueMs - nowMs;
      items.push({
        id: `checklist:${ev.eventId}`,
        source: "checklist",
        severity: left !== null && left <= DAY ? "soon" : "normal",
        group: group(dueMs),
        title: `${open.length} open ${open.length === 1 ? "task" : "tasks"} for ${ev.name}`,
        context: listNames(open.map((t) => t.title)),
        href: ev.href,
        dueAt: ev.scheduledAt,
        actions: [{ kind: "link", label: "Open checklist", href: ev.href }],
      });
    }
  }

  return items;
}

@Injectable()
export class HomeNeedsSection implements DerivedSectionBuilder<NeedItem[]> {
  private readonly log = new Logger(HomeNeedsSection.name);

  constructor(private readonly tickets: TicketsService) {}

  private async unassignedUrgent(ctx: HomeContext): Promise<UnassignedTicket[]> {
    if (!ctx.user.permissions.includes(PERMISSIONS.TICKETS_READ_ANY)) return [];
    try {
      const rows = await this.tickets.list(ctx.user, {
        scope: "all",
        assigned: "unassigned",
        status: ["open"],
        priority: ["high", "urgent"],
        limit: 5,
      });
      return rows.map((r) => ({ id: r.id, number: r.number, title: r.title, priority: asPriority(r.priority) }));
    } catch (err) {
      this.log.debug(`unassigned tickets unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  async build(ctx: HomeContext, primary: PrimarySections): Promise<Section<NeedItem[]>> {
    const sources = [primary.tickets, primary.systems, primary.service, primary.checklists];
    if (sources.every((s) => s.state !== "ok")) {
      return sources.every((s) => s.state === "forbidden")
        ? sectionOff("forbidden")
        : sectionOff("unavailable", "no source available");
    }
    const unassigned = primary.tickets.state === "ok" ? await this.unassignedUrgent(ctx) : [];
    return sectionOk(rankNeeds(buildNeedItems({ now: ctx.now, timezone: ctx.timezone, primary, unassigned })));
  }
}
