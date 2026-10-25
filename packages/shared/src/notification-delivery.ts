import { z } from "zod";
import { zonedParts, zonedTimeToUtc } from "./dashboard/zoned";

/**
 * How and when a person is told: the channels, quiet hours, a once-a-day email summary and the alerts that ignore both.
 * Pure rules shared by the API (which holds and releases mail, and decides on push) and the web (which shows the choices),
 * unit-tested in apps/api/test/notification-delivery.test.ts.
 *
 * The model, in one place:
 *  - In-app is always immediate and silent (a row and the bell); quiet hours and the summary never delay it.
 *  - Push is immediate, except that it is NOT sent during quiet hours (it is dropped, not saved for later: a buzz at 07:00 about
 *    something at 03:00 is stale, and the email summary and the bell still carry it).
 *  - Email is immediate, unless the person asked for a daily summary or the moment falls in quiet hours; then it is held and
 *    released at the next summary time / the end of quiet hours, all together (`emailReleaseAt`).
 *  - Urgent kinds (`URGENT_NOTIFICATION_KINDS`) skip all of that when the person leaves "let urgent alerts through" on.
 */

export const NOTIFICATION_CHANNELS = ["in_app", "email", "push"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/**
 * Kinds that mean something is down right now. They are the ones worth waking someone for, so they get through quiet hours and
 * the daily summary unless the person switches that off. Everything else can wait for the morning.
 */
export const URGENT_NOTIFICATION_KINDS: ReadonlyArray<string> = [
  "monitor.incident.opened",
  "monitor.incident.escalated",
  "infra.alert.opened",
  // UniFi and Cisco send "back online" under the same kind as "offline", so those recoveries get through too.
  "unifi.device_offline",
  "cisco.device_offline",
  "cluster.node_down",
  "dns.primary_unreachable",
];

export function isUrgentNotificationKind(kind: string): boolean {
  return URGENT_NOTIFICATION_KINDS.includes(kind);
}

/** A time of day as minutes after midnight on the site's clock (0 to 1439). */
const minuteOfDay = z.number().int().min(0).max(1439);

export const notificationDeliveryBaseSchema = z.object({
  quietEnabled: z.boolean(),
  quietStart: minuteOfDay,
  quietEnd: minuteOfDay,
  digestEnabled: z.boolean(),
  digestAt: minuteOfDay,
  urgentThrough: z.boolean(),
});

export const notificationDeliverySchema = notificationDeliveryBaseSchema.refine((v) => !v.quietEnabled || v.quietStart !== v.quietEnd, {
    path: ["quietEnd"],
    message: "Quiet hours need an end that differs from the start.",
  });
export type NotificationDelivery = z.infer<typeof notificationDeliverySchema>;

/** What a person with no saved choice gets: everything immediate, as before the feature existed. */
export const DEFAULT_NOTIFICATION_DELIVERY: NotificationDelivery = {
  quietEnabled: false,
  quietStart: 22 * 60,
  quietEnd: 7 * 60,
  digestEnabled: false,
  digestAt: 8 * 60,
  urgentThrough: true,
};

/** "22:30" for 1350. */
export function formatClock(minutes: number): string {
  const m = Math.max(0, Math.min(1439, Math.floor(minutes)));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Minutes after midnight for "22:30" (what `<input type="time">` gives), or null when it is not a time of day. */
export function parseClock(value: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Is `at` inside the person's quiet hours? Always false when they are off. A window that crosses midnight is handled. */
export function inQuietHours(d: NotificationDelivery, at: Date, tz: string): boolean {
  if (!d.quietEnabled || d.quietStart === d.quietEnd) return false;
  const p = zonedParts(at, tz);
  const m = p.hour * 60 + p.minute;
  return d.quietStart < d.quietEnd ? m >= d.quietStart && m < d.quietEnd : m >= d.quietStart || m < d.quietEnd;
}

/** The first instant at or after `from` at which the wall clock of `tz` reads `minutes` after midnight. */
export function nextClockTime(minutes: number, from: Date, tz: string): Date {
  const p = zonedParts(from, tz);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const today = zonedTimeToUtc(tz, p.year, p.month, p.day, h, m);
  if (today.getTime() >= from.getTime()) return today;
  return zonedTimeToUtc(tz, p.year, p.month, p.day + 1, h, m);
}

/** Should a push for this kind go out at `at`? Not during quiet hours, unless the kind is urgent and the person allows it. */
export function pushAllowed(kind: string, d: NotificationDelivery, at: Date, tz: string): boolean {
  if (!inQuietHours(d, at, tz)) return true;
  return d.urgentThrough && isUrgentNotificationKind(kind);
}

/**
 * The first moment an email created at `createdAt` may be sent under the person's CURRENT choices. Equal to `createdAt`
 * means "now". Judged from the creation time and the current settings (nothing is stored), so changing the settings applies to
 * what is already held: switch quiet hours off and the mail goes out at the next release run.
 */
export function emailReleaseAt(kind: string, createdAt: Date, d: NotificationDelivery, tz: string): Date {
  if (d.urgentThrough && isUrgentNotificationKind(kind)) return createdAt;
  let t = createdAt;
  if (d.digestEnabled) t = nextClockTime(d.digestAt, t, tz);
  // A summary time inside quiet hours waits for them to end.
  if (inQuietHours(d, t, tz)) t = nextClockTime(d.quietEnd, t, tz);
  return t;
}

/** Why mail was held, for the heading of the email that releases it. */
export type HeldReason = "digest" | "quiet";

export function heldReason(d: NotificationDelivery): HeldReason {
  return d.digestEnabled ? "digest" : "quiet";
}

/** The most notices one email lists; the rest are counted, and the bell has them all. */
export const HELD_EMAIL_MAX_ITEMS = 40;

// ---- web push --------------------------------------------------------------------------------------------------------

/**
 * Where a browser's push service can live. The server POSTs to the address a browser hands it, so an address that points
 * anywhere else (an internal host) would let a signed-in person make this server send requests there. Only the push services
 * of the browsers in use are accepted: Chrome/Edge/Opera/Samsung (FCM), Firefox, Safari and Edge's Windows service.
 */
const PUSH_HOST_SUFFIXES = ["fcm.googleapis.com", "push.services.mozilla.com", "push.apple.com", "notify.windows.com"] as const;

/** An `https://` address on the default port, with no login in it, on a known push service. */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.port !== "" || u.username !== "" || u.password !== "") return false;
  const host = u.hostname.toLowerCase();
  return PUSH_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}

export const pushSubscribeSchema = z.object({
  endpoint: z.string().url().max(2048).refine(isAllowedPushEndpoint, "Not a browser push service address."),
  keys: z.object({
    p256dh: z.string().min(1).max(256),
    auth: z.string().min(1).max(64),
  }),
});
export type PushSubscribeInput = z.infer<typeof pushSubscribeSchema>;

/** What a push carries. The service worker shows `title` and `body`, and opens `url` when it is clicked. */
export interface PushPayload {
  title: string;
  body: string;
  /** Where a click goes: a path on this site. */
  url: string;
  kind: string;
}

const PUSH_TITLE_MAX = 100;
const PUSH_BODY_MAX = 180;

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 3).trimEnd()}...` : t;
}

/** The payload for a notification: trimmed to what a phone's lock screen shows, with a link that can only be on this site. */
export function pushPayloadFor(n: { kind: string; title: string; body?: string | null; link?: string | null }): PushPayload {
  const link = n.link ?? "";
  // A click opens a path on this site; an absolute address or a protocol-relative one is not followed.
  const url = link.startsWith("/") && !link.startsWith("//") ? link : "/";
  return { title: clip(n.title, PUSH_TITLE_MAX), body: clip(n.body ?? "", PUSH_BODY_MAX), url, kind: n.kind };
}
