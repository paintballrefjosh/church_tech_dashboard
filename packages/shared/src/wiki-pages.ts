import { z } from "zod";

/**
 * Wiki upkeep rules: which pages link to which, when a page is due for another look, and the page templates.
 * Pure functions, used by the API, the review job and the web, and unit-tested in apps/api/test/wiki-pages.test.ts.
 */

// ---- links between pages ---------------------------------------------------------------------------------------------

const FENCE = /(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(\n[ \t]*\2[^\n]*(?=\n|$)|$)/g;
const INLINE_CODE = /`[^`\n]*`/g;
const PAGE_LINK = /\/wiki\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?=$|[\s)\]>"'#?.,;:!])/g;

/**
 * The wiki pages a page body links to: a Markdown link, an autolink or a pasted address that ends in `/wiki/<page id>`
 * (relative or with any host, with an optional `#heading` or `?query`). Links inside code are examples, not links. A link
 * to a page's `/edit` or `/revisions` screen is not a link to the page. Lower-case ids, each once, in order of appearance.
 */
export function extractWikiLinks(body: string): string[] {
  const text = body.replace(FENCE, "$1").replace(INLINE_CODE, "");
  const seen = new Set<string>();
  for (const m of text.matchAll(PAGE_LINK)) seen.add(m[1]!.toLowerCase());
  return [...seen];
}

/**
 * The sentence a link sits in, for showing where a page is mentioned: the first line that links to `pageId`, with the link
 * written out as its text, trimmed to `max` characters. Empty when the body has no such link outside code.
 */
export function wikiLinkContext(body: string, pageId: string, max = 160): string {
  const id = pageId.toLowerCase();
  const lines = body.replace(FENCE, "$1").split("\n");
  for (const raw of lines) {
    if (!extractWikiLinks(raw).includes(id)) continue;
    const text = raw
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/https?:\/\/\S+/g, "")
      .replace(/^[\s>*#\-+\d.]+/, "")
      .replace(/[*_`]+/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return text.length > max ? `${text.slice(0, max - 1).trimEnd()}...` : text;
  }
  return "";
}

// ---- keeping pages up to date ----------------------------------------------------------------------------------------

export const WIKI_REVIEW_DAYS_KEY = "wiki.review.default_days";
/** How long a page may go without an edit or a review before it is flagged, unless the page says otherwise. */
export const WIKI_REVIEW_DEFAULT_DAYS = 180;
export const WIKI_REVIEW_MAX_DAYS = 3650;
/**
 * A page that became due longer ago than this is flagged without telling its owner: turning the check on (or upgrading to
 * the version that has it) must not announce every old page at once. The page still shows as due.
 */
export const WIKI_REVIEW_NOTICE_WINDOW_MS = 3 * 86_400_000;

const DAY_MS = 86_400_000;

/** The site-wide interval from its setting: a whole number of days from 0 (check off) to the maximum, else the default. */
export function wikiReviewDays(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= WIKI_REVIEW_MAX_DAYS ? value : WIKI_REVIEW_DEFAULT_DAYS;
}

export interface WikiReviewSubject {
  updatedAt: Date;
  lastReviewedAt: Date | null;
  /** null = use the site setting, 0 = this page is never flagged, n = flag after n days. */
  reviewIntervalDays: number | null;
}

export interface WikiReviewState {
  /** The interval in force, in days; 0 means the page is not checked. */
  intervalDays: number;
  /** True when the interval is the site setting rather than the page's own. */
  usingDefault: boolean;
  /** The last time someone vouched for the page: its latest edit or review, whichever is later. */
  confirmedAt: Date;
  dueAt: Date | null;
  needsReview: boolean;
  /** Whole days past the due date; 0 when not due. */
  daysOverdue: number;
}

/**
 * Is a page due for another look? The clock starts from the later of the last edit and the last "this is still right"
 * confirmation, so a page someone is working on never nags, and reading is not reviewing. A page with no interval (0, from
 * the page or from the site) is never due.
 */
export function wikiReviewState(page: WikiReviewSubject, defaultDays: number, now: Date): WikiReviewState {
  const usingDefault = page.reviewIntervalDays === null || page.reviewIntervalDays === undefined;
  const intervalDays = usingDefault ? defaultDays : page.reviewIntervalDays!;
  const confirmedAt =
    page.lastReviewedAt && page.lastReviewedAt.getTime() > page.updatedAt.getTime() ? page.lastReviewedAt : page.updatedAt;
  if (intervalDays <= 0) return { intervalDays: 0, usingDefault, confirmedAt, dueAt: null, needsReview: false, daysOverdue: 0 };
  const dueAt = new Date(confirmedAt.getTime() + intervalDays * DAY_MS);
  const late = now.getTime() - dueAt.getTime();
  return { intervalDays, usingDefault, confirmedAt, dueAt, needsReview: late >= 0, daysOverdue: late >= 0 ? Math.floor(late / DAY_MS) : 0 };
}

export type WikiReviewNotice = "notify" | "silent" | null;

/**
 * What to do about a page that may need a nudge. Each page is announced at most once per stretch of being due: a notice
 * already sent since the page was last confirmed is not repeated, and a page that has been due for longer than the notice
 * window is flagged without a message (see `WIKI_REVIEW_NOTICE_WINDOW_MS`).
 */
export function wikiReviewNotice(state: WikiReviewState, notifiedAt: Date | null, now: Date): WikiReviewNotice {
  if (!state.needsReview || !state.dueAt) return null;
  if (notifiedAt && notifiedAt.getTime() >= state.confirmedAt.getTime()) return null;
  return now.getTime() - state.dueAt.getTime() <= WIKI_REVIEW_NOTICE_WINDOW_MS ? "notify" : "silent";
}

/** "3 days", "5 months", "2 years": how long ago, in the unit a person would say. */
export function describeWikiAge(days: number): string {
  if (days < 1) return "today";
  if (days < 60) return `${days} day${days === 1 ? "" : "s"}`;
  if (days < 730) {
    const months = Math.round(days / 30.4);
    return `${months} month${months === 1 ? "" : "s"}`;
  }
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? "" : "s"}`;
}

/** The choices offered for a page's own interval; the site setting is the first. */
export const WIKI_REVIEW_CHOICES: ReadonlyArray<{ value: number | null; label: string }> = [
  { value: null, label: "Site default" },
  { value: 30, label: "Every month" },
  { value: 90, label: "Every 3 months" },
  { value: 180, label: "Every 6 months" },
  { value: 365, label: "Every year" },
  { value: 0, label: "Never (does not go out of date)" },
];

// ---- page templates --------------------------------------------------------------------------------------------------

export const WIKI_TEMPLATE_NAME_MAX = 80;
export const WIKI_TEMPLATE_DESCRIPTION_MAX = 200;
export const WIKI_TEMPLATE_BODY_MAX = 50_000;

export const wikiTemplateSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  body: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type WikiTemplate = z.infer<typeof wikiTemplateSchema>;

export const createWikiTemplateSchema = z.object({
  name: z.string().trim().min(1).max(WIKI_TEMPLATE_NAME_MAX),
  description: z.string().trim().max(WIKI_TEMPLATE_DESCRIPTION_MAX).default(""),
  body: z.string().max(WIKI_TEMPLATE_BODY_MAX),
});
export type CreateWikiTemplateInput = z.infer<typeof createWikiTemplateSchema>;

export const updateWikiTemplateSchema = z.object({
  name: z.string().trim().min(1).max(WIKI_TEMPLATE_NAME_MAX).optional(),
  description: z.string().trim().max(WIKI_TEMPLATE_DESCRIPTION_MAX).optional(),
  body: z.string().max(WIKI_TEMPLATE_BODY_MAX).optional(),
});
export type UpdateWikiTemplateInput = z.infer<typeof updateWikiTemplateSchema>;

export const WIKI_TEMPLATE_VARIABLES = [
  { name: "date", description: "today's date" },
  { name: "author", description: "the person creating the page" },
] as const;

export interface WikiTemplateVars {
  date?: string;
  author?: string;
}

/** Fill `{{date}}` and `{{author}}`. One with no value is left as written so it is seen and fixed, not blanked. */
export function renderWikiTemplate(body: string, vars: WikiTemplateVars): string {
  return body.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (whole, key: string) => {
    const v = (vars as Record<string, string | undefined>)[key];
    return v && v.trim() !== "" ? v : whole;
  });
}

export interface WikiStarterTemplate {
  /** `starter:<slug>`: never a database id, so it cannot be mistaken for a saved template. */
  id: string;
  name: string;
  description: string;
  body: string;
}

/** Ready-made outlines that ship with the app. Saved templates (admin > Wiki > Templates) are added to these. */
export const WIKI_STARTER_TEMPLATES: ReadonlyArray<WikiStarterTemplate> = [
  {
    id: "starter:how-to",
    name: "How-to guide",
    description: "Steps for doing one task, written so someone new can follow it.",
    body: [
      "## What this is for",
      "",
      "One or two sentences on the task and when to do it.",
      "",
      "## Before you start",
      "",
      "- What you need (access, equipment, who to tell)",
      "",
      "## Steps",
      "",
      "1. First step",
      "2. Next step",
      "3. Check that it worked",
      "",
      "## If something goes wrong",
      "",
      "What to try, and who to ask.",
      "",
      "_Written by {{author}} on {{date}}._",
      "",
    ].join("\n"),
  },
  {
    id: "starter:runbook",
    name: "Runbook",
    description: "What to do when a system misbehaves: symptoms, checks, fixes, who to call.",
    body: [
      "## Summary",
      "",
      "What this covers and how serious it is when it is down.",
      "",
      "## Symptoms",
      "",
      "- What people notice",
      "",
      "## Check first",
      "",
      "1. The quickest check",
      "2. The next one",
      "",
      "## Fix",
      "",
      "1. Steps, in order",
      "",
      "## Escalate",
      "",
      "Who to contact if the fix does not work, and how.",
      "",
      "## Last verified",
      "",
      "{{date}} by {{author}}",
      "",
    ].join("\n"),
  },
  {
    id: "starter:system",
    name: "System or service",
    description: "A record of one system: what it does, where it runs, how it is looked after.",
    body: [
      "## What it does",
      "",
      "## Where it runs",
      "",
      "- Address or location:",
      "- Operating system or model:",
      "",
      "## How people sign in",
      "",
      "## Who looks after it",
      "",
      "- Owner:",
      "- Backup contact:",
      "",
      "## Routine care",
      "",
      "- Updates:",
      "- Backups:",
      "",
      "## Related pages",
      "",
    ].join("\n"),
  },
  {
    id: "starter:meeting",
    name: "Meeting notes",
    description: "Who was there, what was decided, who does what by when.",
    body: [
      "**Date:** {{date}}  ",
      "**Notes by:** {{author}}",
      "",
      "## Present",
      "",
      "## Decisions",
      "",
      "- ",
      "",
      "## Actions",
      "",
      "- Who: what, by when",
      "",
      "## Notes",
      "",
    ].join("\n"),
  },
  {
    id: "starter:incident",
    name: "Incident write-up",
    description: "What happened, the effect, the cause, and what changes so it does not happen again.",
    body: [
      "**Date:** {{date}}  ",
      "**Written by:** {{author}}",
      "",
      "## What happened",
      "",
      "## Effect",
      "",
      "Who or what was affected, and for how long.",
      "",
      "## Timeline",
      "",
      "- Time: event",
      "",
      "## Cause",
      "",
      "## What we will change",
      "",
      "- ",
      "",
    ].join("\n"),
  },
];
