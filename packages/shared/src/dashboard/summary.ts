import type { HomeSnapshot } from "./home";
import { calendarDaysBetween, formatTimeInZone, formatWeekdayInZone, zonedParts } from "./zoned";

export type SummaryTone = "ok" | "warn" | "bad";

/** One piece of the written summary. Links carry a tone so a look can colour them. */
export type SummaryToken =
  | { kind: "text"; text: string }
  | { kind: "link"; text: string; href: string; tone: SummaryTone };

export type SummaryInput = Pick<
  HomeSnapshot,
  "timezone" | "generatedAt" | "service" | "systems" | "tickets" | "checklists"
>;

const text = (t: string): SummaryToken => ({ kind: "text", text: t });
const link = (t: string, href: string, tone: SummaryTone): SummaryToken => ({ kind: "link", text: t, href, tone });

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function andList(parts: SummaryToken[][]): SummaryToken[] {
  const out: SummaryToken[] = [];
  parts.forEach((p, i) => {
    if (i > 0) out.push(text(i === parts.length - 1 ? " and " : ", "));
    out.push(...p);
  });
  return out;
}

/** "9:40 tonight", "2:15 pm today", "9:40 am tomorrow", "9:40 am on Friday". */
export function deadlinePhrase(due: Date, now: Date, tz: string): string {
  const days = calendarDaysBetween(now, due, tz);
  const time = formatTimeInZone(due, tz);
  if (days <= 0) {
    if (zonedParts(due, tz).hour >= 17) return `${time.replace(/ ?[ap]m$/, "")} tonight`;
    return `${time} today`;
  }
  if (days === 1) return `${time} tomorrow`;
  return `${time} on ${formatWeekdayInZone(due, tz)}`;
}

function systemsSentence(s: SummaryInput["systems"]): SummaryToken[] {
  if (s.state !== "ok") return [];
  const d = s.data;
  if (d.totals.total === 0 && d.problems.length === 0) return [];
  const partial = d.areas.some((a) => a.state === "unavailable");
  const allGood = partial ? "Everything we can reach is running" : "Everything's running";
  const maintenance = d.maintenanceMode ? " Alerts are paused for maintenance." : "";
  const problems = d.problems;
  if (problems.length === 0) return [text(`${allGood}.${maintenance}`)];
  if (problems.length <= 2) {
    const names = problems.map((p) => [link(p.name, p.href, "bad")]);
    return [text(`${allGood} except `), ...andList(names), text(`.${maintenance}`)];
  }
  return [link(`${problems.length} systems`, "/monitoring", "bad"), text(` are down.${maintenance}`)];
}

interface Clause {
  tokens: SummaryToken[];
  /** The first word may be lower-cased when the clause follows another. */
  soft: boolean;
}

function teamClause(svc: SummaryInput["service"], now: Date, tz: string): Clause | null {
  if (svc.state !== "ok") return null;
  const s = svc.data;
  const start = s.startsAt ? new Date(s.startsAt) : null;
  const days = start ? calendarDaysBetween(now, start, tz) : null;
  let lead: string;
  if (start === null || days === null || days >= 7) lead = "Next service's";
  else if (days <= 0) lead = "Today's";
  else if (days === 1) lead = "Tomorrow's";
  else lead = `${formatWeekdayInZone(start, tz)}'s`;

  if (s.team === null) {
    return {
      tokens: [text("Next up is "), link(s.title, s.href, "ok")],
      soft: false,
    };
  }
  const total = s.team.confirmed + s.team.waiting + s.team.declined;
  if (total === 0) return null;
  const tone: SummaryTone = s.team.declined > 0 ? "bad" : s.team.waiting > 0 ? "warn" : "ok";
  return {
    tokens: [
      text(`${lead} team is `),
      link(`${s.team.confirmed} of ${total}`, s.href, tone),
      text(" confirmed"),
    ],
    soft: false,
  };
}

function ticketClause(t: SummaryInput["tickets"], now: Date, tz: string): Clause | null {
  if (t.state !== "ok") return null;
  const d = t.data;
  const breached = d.mine.filter((x) => x.responseBreached);
  if (breached.length === 1) {
    const x = breached[0]!;
    return { tokens: [link(`#${x.number}`, x.href, "bad"), text(" is overdue for a reply")], soft: false };
  }
  if (breached.length > 1) {
    return {
      tokens: [link(`${breached.length} tickets`, "/tickets", "bad"), text(" are overdue for a reply")],
      soft: false,
    };
  }
  const due = d.mine
    .filter((x) => x.responseDueAt)
    .sort((a, b) => Date.parse(a.responseDueAt!) - Date.parse(b.responseDueAt!))[0];
  if (due?.responseDueAt) {
    return {
      tokens: [
        link(`#${due.number}`, due.href, "warn"),
        text(` needs a reply by ${deadlinePhrase(new Date(due.responseDueAt), now, tz)}`),
      ],
      soft: false,
    };
  }
  if (d.canAssign && d.unassignedCount > 0) {
    return {
      tokens: [
        link(`${d.unassignedCount} ${plural(d.unassignedCount, "ticket", "tickets")}`, "/tickets", "warn"),
        text(` ${plural(d.unassignedCount, "is", "are")} waiting for someone to take ${plural(d.unassignedCount, "it", "them")}`),
      ],
      soft: false,
    };
  }
  if (d.mine.length > 0) {
    return {
      tokens: [
        text("You have "),
        link(`${d.mine.length} open ${plural(d.mine.length, "ticket", "tickets")}`, "/tickets", "ok"),
      ],
      soft: true,
    };
  }
  return null;
}

function checklistClause(c: SummaryInput["checklists"]): Clause | null {
  if (c.state !== "ok") return null;
  const tasks = c.data.events.reduce((n, e) => n + e.tasks.filter((t) => !t.done).length, 0);
  if (tasks === 0) return null;
  const href = c.data.events.length === 1 ? c.data.events[0]!.href : "/checklists";
  return {
    tokens: [
      text("You have "),
      link(`${tasks} checklist ${plural(tasks, "task", "tasks")}`, href, "ok"),
      text(" to do"),
    ],
    soft: true,
  };
}

function lowerFirst(tokens: SummaryToken[]): SummaryToken[] {
  const [first, ...rest] = tokens;
  if (first && first.kind === "text" && first.text.length > 0) {
    return [text(first.text.charAt(0).toLowerCase() + first.text.slice(1)), ...rest];
  }
  return tokens;
}

/**
 * The Start page's sentence, as typed tokens so the web can render links. One or two plain
 * sentences: how the systems are, then what the next service and the person's own queue look
 * like. A section that is missing, forbidden or empty contributes nothing, and nothing is said
 * about data the snapshot does not hold. Returns an empty list when there is nothing to say.
 * Times are in the snapshot's zone.
 */
export function summarize(snapshot: SummaryInput, now: Date = new Date(snapshot.generatedAt)): SummaryToken[] {
  const tz = snapshot.timezone;
  const first = systemsSentence(snapshot.systems);

  const clauses = [
    teamClause(snapshot.service, now, tz),
    ticketClause(snapshot.tickets, now, tz),
    checklistClause(snapshot.checklists),
  ].filter((c): c is Clause => c !== null);
  const used = clauses.slice(0, 2);

  let second: SummaryToken[] = [];
  if (used.length === 1) {
    second = [...used[0]!.tokens, text(".")];
  } else if (used.length === 2) {
    const [a, b] = used as [Clause, Clause];
    second = [...a.tokens, text(", and "), ...(b.soft ? lowerFirst(b.tokens) : b.tokens), text(".")];
  }

  if (first.length > 0 && second.length > 0) return [...first, text(" "), ...second];
  return first.length > 0 ? first : second;
}
