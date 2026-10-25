import { z } from "zod";
import { zonedParts } from "../dashboard/zoned";

/**
 * Renewals: things that lapse on a date unless someone acts (licences such as CCLI streaming or ProPresenter seats,
 * domains, warranties, subscriptions, a nonprofit grant). A date-only `renewsOn` on the site's calendar, reminders a
 * number of days before, and once when it has passed. Rules below are pure, unit-tested in apps/api/test/renewals.test.ts.
 */

export const RENEWAL_CATEGORIES = ["licence", "domain", "warranty", "subscription", "certificate", "other"] as const;
export type RenewalCategory = (typeof RENEWAL_CATEGORIES)[number];

export const RENEWAL_CATEGORY_LABELS: Record<RenewalCategory, string> = {
  licence: "Licence",
  domain: "Domain name",
  warranty: "Warranty or support contract",
  subscription: "Subscription",
  certificate: "Certificate",
  other: "Other",
};

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "A date like 2026-12-31")
  .refine((s) => {
    const t = Date.parse(`${s}T00:00:00Z`);
    // Round-trip, so 2026-02-30 (which some engines roll over to March) is refused.
    return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
  }, "Not a real date");

export const DEFAULT_RENEWAL_REMIND_DAYS = [30, 7] as const;

export const createRenewalSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    category: z.enum(RENEWAL_CATEGORIES).default("licence"),
    vendor: z.string().trim().max(200).default(""),
    renewsOn: isoDate,
    /** Yearly (or per-term) cost in the site's currency, for the list's total; optional. */
    cost: z.number().nonnegative().max(1_000_000_000).nullable().default(null),
    autoRenew: z.boolean().default(false),
    /** Who is told; null = the admin group. */
    ownerUserId: z.string().uuid().nullable().default(null),
    notes: z.string().max(4000).default(""),
    remindDays: z
      .array(z.number().int().min(0).max(365))
      .max(5)
      .default([...DEFAULT_RENEWAL_REMIND_DAYS]),
  })
  .strict();
export type CreateRenewalInput = z.infer<typeof createRenewalSchema>;

export const updateRenewalSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    category: z.enum(RENEWAL_CATEGORIES).optional(),
    vendor: z.string().trim().max(200).optional(),
    renewsOn: isoDate.optional(),
    cost: z.number().nonnegative().max(1_000_000_000).nullable().optional(),
    autoRenew: z.boolean().optional(),
    ownerUserId: z.string().uuid().nullable().optional(),
    notes: z.string().max(4000).optional(),
    remindDays: z.array(z.number().int().min(0).max(365)).max(5).optional(),
  })
  .strict();
export type UpdateRenewalInput = z.infer<typeof updateRenewalSchema>;

export interface Renewal {
  id: string;
  name: string;
  category: RenewalCategory;
  vendor: string;
  renewsOn: string;
  cost: number | null;
  autoRenew: boolean;
  ownerUserId: string | null;
  ownerName: string | null;
  notes: string;
  remindDays: number[];
  createdAt: string;
  updatedAt: string;
}

/** Today's date (YYYY-MM-DD) on the site's calendar. */
export function siteToday(now: Date, tz: string): string {
  const p = zonedParts(now, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Whole days from `today` to `date` (both YYYY-MM-DD); negative once it has passed. */
export function daysUntil(date: string, today: string): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

export type RenewalState = "overdue" | "today" | "soon" | "later";

/** How a renewal is drawn: past, today, within its earliest reminder, or later. */
export function renewalState(r: Pick<Renewal, "renewsOn" | "remindDays">, today: string): RenewalState {
  const left = daysUntil(r.renewsOn, today);
  if (left < 0) return "overdue";
  if (left === 0) return "today";
  // "Soon" is inside the earliest reminder; with no reminders, the default 30 days.
  const window = r.remindDays.length > 0 ? Math.max(...r.remindDays) : DEFAULT_RENEWAL_REMIND_DAYS[0];
  return left <= window ? "soon" : "later";
}

/** A lapsed renewal is reminded about once, and not at all once it is this many days past (history, not news). */
export const RENEWAL_OVERDUE_NOTICE_DAYS = 14;

/**
 * Which reminder is due now, as the marker to store once it is sent (`<renewsOn>:<days>` or `<renewsOn>:overdue`), or null.
 * Only the nearest reminder that has come due counts, so a renewal added 5 days out with reminders at 30 and 7 sends one
 * notice ("7"), not two; moving the date gives new markers, so the reminders start again for the new date.
 */
export function renewalReminderDue(
  r: Pick<Renewal, "renewsOn" | "remindDays">,
  remindedFor: string | null,
  today: string,
): string | null {
  const left = daysUntil(r.renewsOn, today);
  let marker: string | null = null;
  if (left < 0) {
    marker = left >= -RENEWAL_OVERDUE_NOTICE_DAYS ? `${r.renewsOn}:overdue` : null;
  } else {
    const due = r.remindDays.filter((d) => left <= d);
    if (due.length > 0) marker = `${r.renewsOn}:${Math.min(...due)}`;
  }
  if (!marker || marker === remindedFor) return null;
  // Never go back to an earlier (larger) reminder of the same date once a nearer one was sent.
  if (remindedFor?.startsWith(`${r.renewsOn}:`)) {
    const sent = remindedFor.slice(r.renewsOn.length + 1);
    const now = marker.slice(r.renewsOn.length + 1);
    if (sent === "overdue") return null;
    if (now !== "overdue" && Number(now) >= Number(sent)) return null;
  }
  return marker;
}

/** The notice's words for a marker. */
export function renewalNoticeTitle(name: string, renewsOn: string, today: string): string {
  const left = daysUntil(renewsOn, today);
  if (left < 0) return `${name} lapsed on ${renewsOn}`;
  if (left === 0) return `${name} renews today`;
  return `${name} renews in ${left} day${left === 1 ? "" : "s"} (${renewsOn})`;
}
