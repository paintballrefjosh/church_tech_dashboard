/**
 * Alert handling beyond "open an incident and tell everyone": flap suppression, escalation of an incident nobody has
 * acknowledged, and the roll-up shown on the status page. Pure rules, shared by the probe worker (which cannot import the
 * API), the API's escalation job and the tests.
 */

export const ALERT_KEYS = {
  flapIncidents: "monitoring.flap_incidents",
  flapWindowMin: "monitoring.flap_window_min",
  reminderAfterMin: "monitoring.escalate_reminder_min",
  groupAfterMin: "monitoring.escalate_group_min",
  escalationGroup: "monitoring.escalation_group",
  statusNotice: "monitoring.status_notice",
  statusPublic: "monitoring.status_public",
} as const;

export const FLAP_DEFAULT_INCIDENTS = 3;
export const FLAP_DEFAULT_WINDOW_MIN = 30;
export const FLAP_MAX_WINDOW_MIN = 1440;
export const ESCALATION_MAX_MIN = 1440;
/** An open incident older than this is left alone by escalation: it is history, not news. */
export const ESCALATION_MAX_AGE_HOURS = 72;
export const STATUS_NOTICE_MAX = 500;

export interface FlapConfig {
  /** Incidents opened within the window that make a service "flapping"; 0 switches the rule off. */
  incidents: number;
  windowMin: number;
}

/** Read the two flap settings, whatever a stored value looks like. */
export function flapConfig(rawIncidents: unknown, rawWindowMin: unknown): FlapConfig {
  const whole = (v: unknown, fallback: number, min: number, max: number) => {
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
  };
  return {
    incidents: whole(rawIncidents, FLAP_DEFAULT_INCIDENTS, 0, 50),
    windowMin: whole(rawWindowMin, FLAP_DEFAULT_WINDOW_MIN, 1, FLAP_MAX_WINDOW_MIN),
  };
}

/** True when a monitor that has just opened an incident has now opened `config.incidents` within the window. */
export function isFlapping(opensInWindow: number, config: FlapConfig): boolean {
  return config.incidents > 0 && opensInWindow >= config.incidents;
}

/**
 * A flapping monitor is settled once it has stayed in one state for the whole window. `lastChange` is when the newest
 * incident started or (if it has ended) ended: while that incident is open the monitor has been down since it started.
 */
export function flapSettled(lastChange: Date, now: Date, config: FlapConfig): boolean {
  return now.getTime() - lastChange.getTime() >= config.windowMin * 60_000;
}

export type EscalationLevel = 1 | 2;

export interface EscalationConfig {
  /** Minutes before the first reminder to the usual recipients; 0 = off. */
  reminderMin: number;
  /** Minutes before the second group is told; 0 = off. Needs a group to be named. */
  groupMin: number;
  group: string;
}

export function escalationConfig(rawReminder: unknown, rawGroup: unknown, rawGroupName: unknown): EscalationConfig {
  const minutes = (v: unknown) => {
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    return Number.isFinite(n) ? Math.min(ESCALATION_MAX_MIN, Math.max(0, Math.trunc(n))) : 0;
  };
  const group = typeof rawGroupName === "string" ? rawGroupName.trim() : "";
  return { reminderMin: minutes(rawReminder), groupMin: group ? minutes(rawGroup) : 0, group };
}

export interface EscalationSubject {
  startedAt: Date;
  resolvedAt: Date | null;
  acknowledgedAt: Date | null;
  /** 0 = nothing sent yet, 1 = reminder sent, 2 = second group told. */
  escalationLevel: number;
}

/**
 * The step an open incident is due for, or null. The highest step that is due wins when more than one is (a job that was
 * down must not send a reminder and the escalation back to back), and a step is never repeated: acknowledging the incident
 * or resolving it ends the sequence.
 */
export function escalationDue(incident: EscalationSubject, config: EscalationConfig, now: Date): EscalationLevel | null {
  if (incident.resolvedAt || incident.acknowledgedAt) return null;
  const ageMs = now.getTime() - incident.startedAt.getTime();
  if (ageMs < 0 || ageMs > ESCALATION_MAX_AGE_HOURS * 3_600_000) return null;
  if (config.groupMin > 0 && incident.escalationLevel < 2 && ageMs >= config.groupMin * 60_000) return 2;
  if (config.reminderMin > 0 && incident.escalationLevel < 1 && ageMs >= config.reminderMin * 60_000) return 1;
  return null;
}

/** Whole minutes, for a sentence ("down for 25 minutes"). */
export function describeMinutes(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"}`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest === 0 ? `${h} hour${h === 1 ? "" : "s"}` : `${h} h ${rest} min`;
}

// ---- status page ----

export type StatusItemState = "up" | "down" | "flapping" | "unknown";
export type StatusOverall = "ok" | "degraded" | "outage" | "unknown";

export interface StatusItem {
  id: string;
  name: string;
  state: StatusItemState;
  /** Down or unsettled since (ISO); null while up or unknown. */
  since: string | null;
  /** Somebody has taken the open incident. */
  acknowledged: boolean;
}

export interface StatusPage {
  overall: StatusOverall;
  items: StatusItem[];
  /** Alerts are paused for planned work (the maintenance switch). */
  maintenance: { enabled: boolean; until: string | null };
  /** A line an admin wrote for everybody ("Wi-Fi work this Saturday"), or "". */
  notice: string;
  generatedAt: string;
}

/**
 * What the PUBLIC status page (no sign-in, `monitoring.status_public`) carries: the same names and states, without the
 * internal monitor ids. Everything else on the page is already chosen for everybody to read.
 */
export interface PublicStatusPage extends Omit<StatusPage, "items"> {
  items: Array<Omit<StatusItem, "id">>;
}

export function publicStatusPage(page: StatusPage): PublicStatusPage {
  return { ...page, items: page.items.map(({ name, state, since, acknowledged }) => ({ name, state, since, acknowledged })) };
}

/** The headline: all clear, some services trouble, or most of them out. Nothing shown at all is "unknown". */
export function statusOverall(items: ReadonlyArray<Pick<StatusItem, "state">>): StatusOverall {
  const known = items.filter((i) => i.state !== "unknown");
  if (items.length === 0 || known.length === 0) return "unknown";
  const down = known.filter((i) => i.state === "down").length;
  const troubled = known.filter((i) => i.state === "down" || i.state === "flapping").length;
  if (troubled === 0) return "ok";
  return down * 2 >= known.length ? "outage" : "degraded";
}

export const STATUS_OVERALL_TEXT: Record<StatusOverall, string> = {
  ok: "Everything is working",
  degraded: "Some things are having trouble",
  outage: "Several things are down",
  unknown: "Nothing to show yet",
};
