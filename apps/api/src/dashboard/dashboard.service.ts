import { Injectable, Inject } from "@nestjs/common";
import { eq } from "drizzle-orm";
import {
  DEFAULT_DASHBOARD_LAYOUT,
  type TilePlacement,
} from "@church/shared";
import { DB, type Db } from "../db/db.module";
import { dashboardLayouts } from "../db/schema";

@Injectable()
export class DashboardService {
  constructor(@Inject(DB) private readonly db: Db) {}

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
