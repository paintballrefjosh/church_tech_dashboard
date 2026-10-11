import { Injectable, Logger } from "@nestjs/common";
import {
  sectionOff,
  type HomeInclude,
  type HomeSnapshot,
  type NeedItem,
  type Section,
} from "@church/shared";
import { SettingsService } from "../../settings/settings.service";
import type { AuthenticatedUser } from "../../auth/current-user.decorator";
import type { HomeContext, PrimarySections } from "./home.types";
import {
  HomeActivitySection,
  HomeAvailabilitySection,
  HomeChecklistsSection,
  HomeMetersSection,
  HomeNeedsSection,
  HomeNotesSection,
  HomeReadinessSection,
  HomeServiceSection,
  HomeSystemsSection,
  HomeTicketsSection,
  HomeWeekSection,
  HomeWikiSection,
} from "./sections";

export const SECTION_TIMEOUT_MS = 2500;

function validZone(zone: unknown): string {
  if (typeof zone !== "string" || zone.trim() === "") return "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return zone;
  } catch {
    return "UTC";
  }
}

/** Morning before 12:00, afternoon before 17:00, otherwise evening, by the clock in `timezone`. */
export function dayPartIn(now: Date, timezone: string): HomeSnapshot["dayPart"] {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: timezone }).format(now),
  );
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}

export function firstNameOf(user: Pick<AuthenticatedUser, "name" | "email">): string {
  const fromName = user.name?.trim().split(/\s+/)[0];
  if (fromName) return fromName;
  return user.email.split("@")[0] ?? "";
}

function asString(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

/**
 * Builds the home snapshot. Every section runs under its own timeout, so one slow or failing
 * source costs only its section (`unavailable`), never the page. No caching here: a section that
 * reads a slow external system keeps its own small cache.
 */
@Injectable()
export class HomeService {
  private readonly log = new Logger(HomeService.name);
  /** Per-section budget; a field so tests can shorten it. */
  sectionTimeoutMs = SECTION_TIMEOUT_MS;

  constructor(
    private readonly settings: SettingsService,
    private readonly service: HomeServiceSection,
    private readonly systems: HomeSystemsSection,
    private readonly tickets: HomeTicketsSection,
    private readonly checklists: HomeChecklistsSection,
    private readonly wiki: HomeWikiSection,
    private readonly notes: HomeNotesSection,
    private readonly activity: HomeActivitySection,
    private readonly week: HomeWeekSection,
    private readonly availability: HomeAvailabilitySection,
    private readonly meters: HomeMetersSection,
    private readonly needs: HomeNeedsSection,
    private readonly readiness: HomeReadinessSection,
  ) {}

  private async guarded<T>(name: string, run: () => Promise<Section<T>>): Promise<Section<T>> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<Section<T>>((resolve) => {
      timer = setTimeout(() => {
        this.log.debug(`home section "${name}" timed out after ${this.sectionTimeoutMs} ms`);
        resolve(sectionOff("unavailable", "timed out"));
      }, this.sectionTimeoutMs);
    });
    try {
      return await Promise.race([
        run().catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.log.debug(`home section "${name}" failed: ${msg}`);
          return sectionOff<T>("unavailable", "failed");
        }),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async snapshot(user: AuthenticatedUser, includes: readonly HomeInclude[], now = new Date()): Promise<HomeSnapshot> {
    const [tz, siteName, tagline] = await Promise.all([
      this.settings.get("site.timezone").catch(() => "UTC"),
      this.settings.get("site.name").catch(() => ""),
      this.settings.get("site.tagline").catch(() => ""),
    ]);
    const timezone = validZone(tz);
    const ctx: HomeContext = { user, now, timezone, includes: new Set(includes) };

    const [service, systems, tickets, checklists, wiki, notes, activity] = await Promise.all([
      this.guarded("service", () => this.service.build(ctx)),
      this.guarded("systems", () => this.systems.build(ctx)),
      this.guarded("tickets", () => this.tickets.build(ctx)),
      this.guarded("checklists", () => this.checklists.build(ctx)),
      this.guarded("wiki", () => this.wiki.build(ctx)),
      this.guarded("notes", () => this.notes.build(ctx)),
      this.guarded("activity", () => this.activity.build(ctx)),
    ]);
    const primary: PrimarySections = { service, systems, tickets, checklists, wiki, notes, activity };

    const has = (i: HomeInclude) => ctx.includes.has(i);
    const [week, availability, meters] = await Promise.all([
      has("week") ? this.guarded("week", () => this.week.build(ctx)) : undefined,
      has("availability") ? this.guarded("availability", () => this.availability.build(ctx)) : undefined,
      has("meters") ? this.guarded("meters", () => this.meters.build(ctx)) : undefined,
    ]);
    const [needs, readiness] = await Promise.all([
      this.guarded<NeedItem[]>("needs", () => this.needs.build(ctx, primary)),
      has("readiness") ? this.guarded("readiness", () => this.readiness.build(ctx, primary)) : undefined,
    ]);

    const snapshot: HomeSnapshot = {
      generatedAt: now.toISOString(),
      timezone,
      dayPart: dayPartIn(now, timezone),
      user: { id: user.id, firstName: firstNameOf(user) },
      site: { name: asString(siteName, ""), tagline: asString(tagline, "") },
      ...primary,
      needs,
    };
    if (week) snapshot.week = week;
    if (readiness) snapshot.readiness = readiness;
    if (availability) snapshot.availability = availability;
    if (meters) snapshot.meters = meters;
    return snapshot;
  }
}
