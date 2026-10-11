import { Injectable, Inject, BadRequestException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import {
  DASHBOARD_LOOKS,
  DEFAULT_DASHBOARD_LAYOUT,
  DEFAULT_LOOK,
  cleanLookSections,
  LOOK_IDS,
  isLookId,
  type LookId,
  type TilePlacement,
  type UpdateDashboardPrefs,
} from "@church/shared";
import { DB, type Db } from "../db/db.module";
import { dashboardLayouts, dashboardPrefs } from "../db/schema";
import { SettingsService } from "../settings/settings.service";

export interface DashboardPrefsView {
  theme: LookId | null;
  sections: Record<string, string[]>;
  siteDefault: LookId;
  enabled: LookId[];
  available: LookId[];
}

/** The site default look; "tiles" when the setting is missing or not a known look. */
export function normaliseSiteDefault(value: unknown): LookId {
  return isLookId(value) ? value : DEFAULT_LOOK;
}

/** The offered looks, in catalogue order; every look when the setting is missing, malformed or empty. */
export function normaliseEnabled(value: unknown): LookId[] {
  if (!Array.isArray(value)) return [...LOOK_IDS];
  const ids = LOOK_IDS.filter((id) => value.includes(id));
  return ids.length > 0 ? ids : [...LOOK_IDS];
}

/** Enabled looks whose required permissions the caller holds. `start` is always included. */
export function availableLooks(enabled: readonly LookId[], permissions: readonly string[]): LookId[] {
  return DASHBOARD_LOOKS.filter(
    (l) => l.id === "start" || (enabled.includes(l.id) && l.requires.every((p) => permissions.includes(p))),
  ).map((l) => l.id);
}

/** Throws 400 when a requested theme is not one the caller may choose; null (site default) always passes. */
export function assertThemeAvailable(theme: LookId | null | undefined, available: readonly LookId[]): void {
  if (theme == null) return;
  if (!available.includes(theme)) {
    throw new BadRequestException(`The look "${theme}" is not available to you.`);
  }
}

/** Keeps only known looks and, for each, only section ids that look offers (unknown ones are dropped). */
export function cleanSections(value: unknown): Record<string, string[]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(value)) {
    if (!isLookId(k) || !Array.isArray(v) || !v.every((x) => typeof x === "string")) continue;
    const ids = cleanLookSections(k, v as string[]);
    if (ids.length > 0) out[k] = ids;
  }
  return out;
}

@Injectable()
export class DashboardService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly settings: SettingsService,
  ) {}

  async getPrefs(userId: string, permissions: readonly string[]): Promise<DashboardPrefsView> {
    const [row] = await this.db.select().from(dashboardPrefs).where(eq(dashboardPrefs.userId, userId)).limit(1);
    const siteDefault = normaliseSiteDefault(await this.settings.get("dashboard.default_theme"));
    const enabled = normaliseEnabled(await this.settings.get("dashboard.enabled_themes"));
    return {
      theme: row && isLookId(row.theme) ? row.theme : null,
      sections: cleanSections(row?.sections),
      siteDefault,
      enabled,
      available: availableLooks(enabled, permissions),
    };
  }

  async updatePrefs(
    userId: string,
    permissions: readonly string[],
    input: UpdateDashboardPrefs,
  ): Promise<DashboardPrefsView> {
    const current = await this.getPrefs(userId, permissions);
    assertThemeAvailable(input.theme, current.available);
    const theme = input.theme === undefined ? current.theme : input.theme;
    const sections = input.sections === undefined ? current.sections : cleanSections(input.sections);
    const now = new Date();
    await this.db
      .insert(dashboardPrefs)
      .values({ userId, theme, sections: sections as never, updatedAt: now })
      .onConflictDoUpdate({
        target: dashboardPrefs.userId,
        set: { theme, sections: sections as never, updatedAt: now },
      });
    return { ...current, theme, sections };
  }

  /**
   * Returns the user's saved layout, or the seeded default if they've never
   * customised theirs. The default is returned by value, not persisted — only
   * an explicit save writes a row.
   */
  async getLayout(userId: string): Promise<TilePlacement[]> {
    const [row] = await this.db
      .select()
      .from(dashboardLayouts)
      .where(eq(dashboardLayouts.userId, userId))
      .limit(1);
    if (!row) return DEFAULT_DASHBOARD_LAYOUT;
    const stored = row.layout as unknown;
    if (!Array.isArray(stored)) return DEFAULT_DASHBOARD_LAYOUT;
    return stored as TilePlacement[];
  }

  async saveLayout(userId: string, layout: TilePlacement[]): Promise<void> {
    await this.db
      .insert(dashboardLayouts)
      .values({ userId, layout: layout as never, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: dashboardLayouts.userId,
        set: { layout: layout as never, updatedAt: new Date() },
      });
  }

  async reset(userId: string): Promise<void> {
    await this.db.delete(dashboardLayouts).where(eq(dashboardLayouts.userId, userId));
  }
}
