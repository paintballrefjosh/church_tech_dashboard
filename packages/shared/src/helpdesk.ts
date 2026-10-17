/**
 * Helpdesk rules that more than one place needs: the "waiting on requester" bookkeeping, the SLA warnings, and canned
 * reply placeholders. Pure, so the API service, the SLA job, the web and the tests agree.
 */
import {
  ticketSlaElapsedMs,
  type Ticket,
  type TicketSlaMap,
  type TicketStatus,
} from "./schemas/ticket";

export const SLA_WARN_PERCENT_KEY = "tickets.sla.warn_percent";
export const SLA_WARN_PERCENT_DEFAULT = 80;
/** A warning or breach noticed this long after it happened is history (the job was down, or this is the first run): flagged, not announced. */
export const SLA_ALERT_STALE_MS = 2 * 3_600_000;

/** Read the warn-at percentage; 0 switches warnings off, anything unreadable is the default. */
export function slaWarnPercent(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return SLA_WARN_PERCENT_DEFAULT;
  return Math.min(95, Math.max(0, Math.trunc(n)));
}

export interface WaitingState {
  status: TicketStatus;
  waitingSince: Date | null;
  waitedMs: number;
}

/**
 * The waiting bookkeeping for a status change: entering `waiting` starts the pause, leaving it adds the time to
 * `waitedMs`. Anything else is returned unchanged, so it is safe to call on every update.
 */
export function waitingTransition(current: WaitingState, next: TicketStatus, now: Date): { waitingSince: Date | null; waitedMs: number } {
  const wasWaiting = current.status === "waiting";
  if (next === "waiting") {
    return { waitingSince: wasWaiting && current.waitingSince ? current.waitingSince : now, waitedMs: current.waitedMs };
  }
  if (wasWaiting || current.waitingSince) {
    const since = current.waitingSince ?? now;
    return { waitingSince: null, waitedMs: current.waitedMs + Math.max(0, now.getTime() - since.getTime()) };
  }
  return { waitingSince: null, waitedMs: current.waitedMs };
}

/** When the requester answers a ticket that was waiting on them it goes back to work: in progress if somebody has it, else open. */
export function statusAfterRequesterReply(status: TicketStatus, hasAssignee: boolean): TicketStatus {
  if (status !== "waiting") return status;
  return hasAssignee ? "in_progress" : "open";
}

export type SlaClock = "response" | "resolution";
export type SlaAlertLevel = "warn" | "breach";

export interface SlaAlertSubject
  extends Pick<Ticket, "priority" | "createdAt" | "firstResponseAt" | "status"> {
  waitingSince?: string | null;
  waitedMs?: number;
}

export interface SlaFlags {
  responseWarned: boolean;
  responseBreached: boolean;
  resolutionWarned: boolean;
  resolutionBreached: boolean;
}

export interface SlaAlert {
  clock: SlaClock;
  level: SlaAlertLevel;
  /** Noticed far too late to be news: record it, do not announce it. */
  stale: boolean;
  /** Minutes the target allows (for the message). */
  targetMin: number;
}

/**
 * The SLA notices a ticket is due, at most one per clock (a breach replaces a warning that was not sent yet). Tickets
 * that are waiting on the requester or finished have no running clock and get nothing.
 */
export function slaAlertsDue(
  ticket: SlaAlertSubject,
  map: TicketSlaMap,
  warnPercent: number,
  flags: SlaFlags,
  now: Date,
): SlaAlert[] {
  if (ticket.status !== "open" && ticket.status !== "in_progress") return [];
  const target = map[ticket.priority];
  const elapsed = ticketSlaElapsedMs(ticket, now);
  const out: SlaAlert[] = [];

  const consider = (clock: SlaClock, targetMin: number, warned: boolean, breached: boolean) => {
    if (targetMin <= 0 || breached) return;
    const targetMs = targetMin * 60_000;
    if (elapsed > targetMs) {
      out.push({ clock, level: "breach", stale: elapsed - targetMs > SLA_ALERT_STALE_MS, targetMin });
      return;
    }
    const warnMs = (targetMs * warnPercent) / 100;
    if (warnPercent > 0 && !warned && elapsed >= warnMs) {
      out.push({ clock, level: "warn", stale: elapsed - warnMs > SLA_ALERT_STALE_MS, targetMin });
    }
  };

  if (!ticket.firstResponseAt) consider("response", target.responseMin, flags.responseWarned, flags.responseBreached);
  consider("resolution", target.resolutionMin, flags.resolutionWarned, flags.resolutionBreached);
  return out;
}

/** "an hour", "45 minutes", "2 days": a target or remaining time in words. */
export function describeSlaMinutes(min: number): string {
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"}`;
  if (min < 1440) {
    const h = Math.round(min / 60);
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  const d = Math.round(min / 1440);
  return `${d} day${d === 1 ? "" : "s"}`;
}

// ---- canned replies ----

export const CANNED_REPLY_VARIABLES = [
  { key: "requester", label: "Requester's name" },
  { key: "agent", label: "Your name" },
  { key: "ticket_number", label: "Ticket number" },
  { key: "ticket_title", label: "Ticket title" },
] as const;

export type CannedReplyVars = Partial<Record<(typeof CANNED_REPLY_VARIABLES)[number]["key"], string>>;

/**
 * Fill {{placeholders}} in a canned reply. An unknown placeholder, or one with no value, is left as written so the
 * person sending it sees it and fixes it, rather than a reply going out with a blank in the middle.
 */
export function renderCannedReply(body: string, vars: CannedReplyVars): string {
  return body.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (whole, key: string) => {
    const v = (vars as Record<string, string | undefined>)[key];
    return v && v.trim() !== "" ? v : whole;
  });
}
