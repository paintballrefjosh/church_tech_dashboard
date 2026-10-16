/**
 * Maintenance mode silences alert notifications. It can carry an end time, so a switch someone forgot ends by itself:
 * `monitoring.maintenance_mode` (boolean) says it is on, `monitoring.maintenance_until` (ISO timestamp, "" = no end) says
 * until when. Every place that decides whether to notify asks `maintenanceState` with the two stored values and the
 * current time, so the answer is the same everywhere (the API, the pollers and the probe worker read the raw settings).
 */
export const MAINTENANCE_MODE_KEY = "monitoring.maintenance_mode";
export const MAINTENANCE_UNTIL_KEY = "monitoring.maintenance_until";

/** Longest window that can be set in one go; a longer silence has to be switched on with no end time on purpose. */
export const MAINTENANCE_MAX_MINUTES = 7 * 24 * 60;

export interface MaintenanceState {
  /** Alerts are silenced right now. */
  active: boolean;
  /** When the window ends (epoch ms), or null when it has no end (or is off). */
  until: number | null;
  /** The switch is still on in the settings but its end time has passed. */
  expired: boolean;
}

export function parseMaintenanceUntil(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

export function maintenanceState(enabled: unknown, until: unknown, now: number = Date.now()): MaintenanceState {
  if (enabled !== true) return { active: false, until: null, expired: false };
  const end = parseMaintenanceUntil(until);
  // A value that is present but unreadable counts as "no end": failing to silence is the safer direction, but a
  // switch that says on must not quietly turn itself off because of a typo either.
  if (end === null) return { active: true, until: null, expired: false };
  if (end <= now) return { active: false, until: end, expired: true };
  return { active: true, until: end, expired: false };
}
