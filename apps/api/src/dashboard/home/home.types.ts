import type {
  ActivityItem,
  ChecklistDigest,
  HomeInclude,
  NextService,
  NotesDigest,
  Section,
  SystemsHealth,
  TicketDigest,
  WikiDigest,
} from "@church/shared";
import type { AuthenticatedUser } from "../../auth/current-user.decorator";

/** What every section builder gets: who is asking, when, in which zone, and what was requested. */
export interface HomeContext {
  user: AuthenticatedUser;
  now: Date;
  /** IANA zone from `site.timezone`. */
  timezone: string;
  includes: ReadonlySet<HomeInclude>;
}

/** A section built from the database or an integration, independent of the other sections. */
export interface SectionBuilder<T> {
  build(ctx: HomeContext): Promise<Section<T>>;
}

/** The primary sections, as handed to the derived builders (`needs`, `readiness`). */
export interface PrimarySections {
  service: Section<NextService>;
  systems: Section<SystemsHealth>;
  tickets: Section<TicketDigest>;
  checklists: Section<ChecklistDigest>;
  wiki: Section<WikiDigest>;
  notes: Section<NotesDigest>;
  activity: Section<ActivityItem[]>;
}

/** A section computed from the primary ones. */
export interface DerivedSectionBuilder<T> {
  build(ctx: HomeContext, primary: PrimarySections): Promise<Section<T>>;
}
