import { Inject, Injectable } from "@nestjs/common";
import { sectionOk, type ActivityItem, type Section } from "@church/shared";
import { DB, type Db } from "../../../db/db.module";
import { ActivityService } from "../../../activity/activity.service";
import type { HomeContext, SectionBuilder } from "../home.types";
import { loadUserNames } from "../names";

export const ACTIVITY_LIMIT = 10;

/**
 * The newest activity events this person may see, exactly as `GET /activity` returns them
 * (`ActivityService.list` holds each event to the read rule of the thing it is about).
 */
@Injectable()
export class HomeActivitySection implements SectionBuilder<ActivityItem[]> {
  constructor(
    private readonly activity: ActivityService,
    @Inject(DB) private readonly db: Db,
  ) {}

  async build(ctx: HomeContext): Promise<Section<ActivityItem[]>> {
    const rows = await this.activity.list(ctx.user, ACTIVITY_LIMIT);
    const names = await loadUserNames(this.db, rows.map((r) => r.actorUserId));
    return sectionOk(
      rows.map((r) => ({
        id: r.id,
        at: r.ts.toISOString(),
        actorName: (r.actorUserId ? names.get(r.actorUserId) : undefined) ?? (r.actorEmail ? r.actorEmail.split("@")[0] ?? null : null),
        summary: r.summary ? `${r.title}: ${r.summary}` : r.title,
        href: r.link ?? null,
        kind: r.action,
      })),
    );
  }
}
