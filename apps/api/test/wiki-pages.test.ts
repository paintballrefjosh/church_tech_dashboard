import { describe, expect, it } from "vitest";
import {
  WIKI_REVIEW_DEFAULT_DAYS,
  WIKI_REVIEW_NOTICE_WINDOW_MS,
  WIKI_STARTER_TEMPLATES,
  createWikiTemplateSchema,
  describeWikiAge,
  extractWikiLinks,
  renderWikiTemplate,
  wikiLinkContext,
  wikiReviewDays,
  wikiReviewNotice,
  wikiReviewState,
} from "@church/shared";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const DAY = 86_400_000;
const d = (iso: string) => new Date(iso);

describe("extractWikiLinks", () => {
  it("finds relative and absolute links, once each, in order", () => {
    const body = `See [the router](/wiki/${A}) and https://dash.example.org/wiki/${B}#setup, also [again](/wiki/${A}).`;
    expect(extractWikiLinks(body)).toEqual([A, B]);
  });

  it("accepts a bare address, an autolink and an upper-case id", () => {
    expect(extractWikiLinks(`<https://x.test/wiki/${A.toUpperCase()}>`)).toEqual([A]);
    expect(extractWikiLinks(`go to /wiki/${B}?x=1 now`)).toEqual([B]);
    expect(extractWikiLinks(`(/wiki/${B})`)).toEqual([B]);
  });

  it("ignores links inside code, which are examples", () => {
    const body = ["Use `/wiki/" + A + "` as the path.", "```", `[x](/wiki/${B})`, "```", "", `Real: [y](/wiki/${B})`].join("\n");
    expect(extractWikiLinks(body)).toEqual([B]);
    expect(extractWikiLinks("~~~\n/wiki/" + A + "\n~~~")).toEqual([]);
  });

  it("does not take the edit or history screens, other paths or half an id for a page link", () => {
    expect(extractWikiLinks(`/wiki/${A}/edit`)).toEqual([]);
    expect(extractWikiLinks(`/wiki/${A}/revisions`)).toEqual([]);
    expect(extractWikiLinks(`/wiki/new`)).toEqual([]);
    expect(extractWikiLinks(`/wiki/${A.slice(0, 20)}`)).toEqual([]);
    expect(extractWikiLinks(`/wiki/${A}0`)).toEqual([]);
    expect(extractWikiLinks("")).toEqual([]);
  });

  it("keeps reading after an unclosed fence", () => {
    expect(extractWikiLinks("```\n/wiki/" + A)).toEqual([]);
  });
});

describe("wikiLinkContext", () => {
  it("gives the line a link sits in, as plain words", () => {
    const body = `# Title\n\n- **Switches**: configured as in [the core switch](/wiki/${A}) page.\n- other`;
    expect(wikiLinkContext(body, A)).toBe("Switches: configured as in the core switch page.");
  });

  it("is empty when only code mentions the page, and cut to a length", () => {
    expect(wikiLinkContext("`/wiki/" + A + "`", A)).toBe("");
    const long = `${"word ".repeat(60)}[x](/wiki/${A})`;
    const out = wikiLinkContext(long, A, 40);
    expect(out.length).toBeLessThanOrEqual(43);
    expect(out.endsWith("...")).toBe(true);
  });
});

describe("wikiReviewState", () => {
  const now = d("2026-10-17T12:00:00Z");
  const base = { updatedAt: d("2026-01-01T00:00:00Z"), lastReviewedAt: null as Date | null, reviewIntervalDays: null as number | null };

  it("is due once the interval has passed since the last edit", () => {
    const s = wikiReviewState(base, 180, now);
    expect(s.needsReview).toBe(true);
    expect(s.usingDefault).toBe(true);
    expect(s.intervalDays).toBe(180);
    expect(s.dueAt?.toISOString()).toBe("2026-06-30T00:00:00.000Z");
    expect(s.daysOverdue).toBe(109);
  });

  it("starts the clock from the later of the edit and the review", () => {
    const reviewed = wikiReviewState({ ...base, lastReviewedAt: d("2026-09-01T00:00:00Z") }, 180, now);
    expect(reviewed.needsReview).toBe(false);
    expect(reviewed.confirmedAt.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    const editedLater = wikiReviewState({ ...base, updatedAt: d("2026-10-01T00:00:00Z"), lastReviewedAt: d("2026-02-01T00:00:00Z") }, 180, now);
    expect(editedLater.confirmedAt.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(editedLater.needsReview).toBe(false);
  });

  it("uses the page's own interval, and 0 means never", () => {
    expect(wikiReviewState({ ...base, reviewIntervalDays: 365 }, 180, now).needsReview).toBe(false);
    expect(wikiReviewState({ ...base, reviewIntervalDays: 30 }, 0, now).needsReview).toBe(true);
    const never = wikiReviewState({ ...base, reviewIntervalDays: 0 }, 180, now);
    expect(never).toMatchObject({ needsReview: false, dueAt: null, intervalDays: 0, usingDefault: false });
  });

  it("flags nothing while the site check is off and the page has no interval of its own", () => {
    expect(wikiReviewState(base, 0, now)).toMatchObject({ needsReview: false, dueAt: null, intervalDays: 0 });
  });

  it("is due at the exact moment and not before", () => {
    const due = new Date(base.updatedAt.getTime() + 180 * DAY);
    expect(wikiReviewState(base, 180, new Date(due.getTime() - 1)).needsReview).toBe(false);
    expect(wikiReviewState(base, 180, due)).toMatchObject({ needsReview: true, daysOverdue: 0 });
  });
});

describe("wikiReviewDays", () => {
  it("takes a whole number in range and otherwise the default", () => {
    expect(wikiReviewDays(90)).toBe(90);
    expect(wikiReviewDays(0)).toBe(0);
    expect(wikiReviewDays(undefined)).toBe(WIKI_REVIEW_DEFAULT_DAYS);
    expect(wikiReviewDays("30")).toBe(WIKI_REVIEW_DEFAULT_DAYS);
    expect(wikiReviewDays(-1)).toBe(WIKI_REVIEW_DEFAULT_DAYS);
    expect(wikiReviewDays(1.5)).toBe(WIKI_REVIEW_DEFAULT_DAYS);
    expect(wikiReviewDays(99999)).toBe(WIKI_REVIEW_DEFAULT_DAYS);
  });
});

describe("wikiReviewNotice", () => {
  const updatedAt = d("2026-01-01T00:00:00Z");
  const state = wikiReviewState({ updatedAt, lastReviewedAt: null, reviewIntervalDays: null }, 100, d("2026-12-01T00:00:00Z"));
  const dueAt = state.dueAt!;

  it("announces a page that has just become due", () => {
    expect(wikiReviewNotice(state, null, new Date(dueAt.getTime() + DAY))).toBe("notify");
  });

  it("flags quietly a page that has been due for longer than the window", () => {
    expect(wikiReviewNotice(state, null, new Date(dueAt.getTime() + WIKI_REVIEW_NOTICE_WINDOW_MS + 1))).toBe("silent");
    expect(wikiReviewNotice(state, null, new Date(dueAt.getTime() + WIKI_REVIEW_NOTICE_WINDOW_MS))).toBe("notify");
  });

  it("says nothing twice, until the page is edited or reviewed and comes due again", () => {
    const now = new Date(dueAt.getTime() + DAY);
    expect(wikiReviewNotice(state, now, new Date(now.getTime() + DAY))).toBeNull();
    const reviewedAt = d("2026-12-01T00:00:00Z");
    const later = d("2027-03-12T00:00:00Z");
    const again = wikiReviewState({ updatedAt, lastReviewedAt: reviewedAt, reviewIntervalDays: null }, 100, later);
    expect(again.needsReview).toBe(true);
    expect(wikiReviewNotice(again, now, later)).toBe("notify");
  });

  it("says nothing about a page that is not due", () => {
    const fresh = wikiReviewState({ updatedAt, lastReviewedAt: null, reviewIntervalDays: null }, 100, d("2026-02-01T00:00:00Z"));
    expect(wikiReviewNotice(fresh, null, d("2026-02-01T00:00:00Z"))).toBeNull();
  });
});

describe("describeWikiAge", () => {
  it("speaks in the unit a person would", () => {
    expect(describeWikiAge(0)).toBe("today");
    expect(describeWikiAge(1)).toBe("1 day");
    expect(describeWikiAge(20)).toBe("20 days");
    expect(describeWikiAge(100)).toBe("3 months");
    expect(describeWikiAge(400)).toBe("13 months");
    expect(describeWikiAge(800)).toBe("2 years");
  });
});

describe("page templates", () => {
  it("fills the date and author, and leaves what it cannot fill", () => {
    expect(renderWikiTemplate("On {{date}} by {{ author }} {{other}}", { date: "2026-10-17", author: "Sam" })).toBe("On 2026-10-17 by Sam {{other}}");
    expect(renderWikiTemplate("{{date}}", {})).toBe("{{date}}");
    expect(renderWikiTemplate("{{date}}", { date: "  " })).toBe("{{date}}");
  });

  it("ships starters with unique ids, names and real content", () => {
    const ids = WIKI_STARTER_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of WIKI_STARTER_TEMPLATES) {
      expect(t.id).toMatch(/^starter:[a-z-]+$/);
      expect(t.name.length).toBeGreaterThan(2);
      expect(t.body.length).toBeGreaterThan(40);
      expect(t.body).not.toMatch(/[^\x00-\x7F]/);
    }
  });

  it("validates a saved template", () => {
    expect(createWikiTemplateSchema.safeParse({ name: "  Setup  ", body: "x" })).toMatchObject({ success: true, data: { name: "Setup", description: "" } });
    expect(createWikiTemplateSchema.safeParse({ name: "", body: "x" }).success).toBe(false);
    expect(createWikiTemplateSchema.safeParse({ name: "a", body: "x".repeat(50_001) }).success).toBe(false);
  });
});
