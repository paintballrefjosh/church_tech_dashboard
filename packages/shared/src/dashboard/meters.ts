/**
 * Front of House meters: how a real reading becomes a 0..1 level, and how it is worded.
 * Each scale is written down here, next to its constant, so the meter is never a guess.
 * A level is a meter fill, not a health verdict: the state LED comes from the systems section.
 */

/** Servers: level is the average CPU percentage across enabled hosts, divided by 100. */
export const SERVERS_FULL_SCALE_PCT = 100;
/** Internet: level is the median latency of the latest check of each monitor; 200 ms fills the meter. */
export const INTERNET_FULL_SCALE_MS = 200;
/** Wi-Fi: level is connected clients; 250 clients fills the meter (a mid-sized church building). */
export const WIFI_FULL_SCALE_CLIENTS = 250;
/** DNS: level is queries per minute over the last hour; 1000 per minute fills the meter. */
export const DNS_FULL_SCALE_QPM = 1000;

/** Keeps a level inside 0..1; anything not finite becomes null (an unreadable meter, never zero). */
export function clampLevel(v: number | null | undefined): number | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  return Math.min(1, Math.max(0, v));
}

/** value / full, clamped. A non-positive scale or a missing value gives null. */
export function scaleLevel(value: number | null | undefined, full: number): number | null {
  if (value === null || value === undefined || !Number.isFinite(value) || full <= 0) return null;
  return clampLevel(value / full);
}

export const serversLevel = (avgCpuPct: number | null) => scaleLevel(avgCpuPct, SERVERS_FULL_SCALE_PCT);
export const internetLevel = (medianMs: number | null) => scaleLevel(medianMs, INTERNET_FULL_SCALE_MS);
export const wifiLevel = (clients: number | null) => scaleLevel(clients, WIFI_FULL_SCALE_CLIENTS);
export const dnsLevel = (queriesPerMin: number | null) => scaleLevel(queriesPerMin, DNS_FULL_SCALE_QPM);

/** Switches: level is ports up / ports known. No ports known gives null. */
export function switchesLevel(portsUp: number, portsTotal: number): number | null {
  if (!(portsTotal > 0)) return null;
  return clampLevel(portsUp / portsTotal);
}

export function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function formatPercent(v: number | null): string {
  return v === null || !Number.isFinite(v) ? "unavailable" : `${Math.round(v)}%`;
}

export function formatLatency(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "unavailable";
  return ms < 10 ? `${Math.round(ms * 10) / 10} ms` : `${Math.round(ms)} ms`;
}

/** "2 min ago", "3 h ago", "4 d ago"; "just now" under a minute; "never" when there is no time. */
export function agoText(then: Date | null, now: Date): string {
  if (!then || Number.isNaN(then.getTime())) return "never";
  const mins = Math.floor(Math.max(0, now.getTime() - then.getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)} h ago`;
  return `${Math.floor(mins / (60 * 24))} d ago`;
}

/** A length of time in words: "40 s", "4 min", "2 h", "3 d". */
export function durationText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}
