import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { WIKI_REVIEW_DAYS_KEY, wikiReviewDays, wikiReviewNotice, wikiReviewState } from "@church/shared";
import { DB, type Db } from "../db/db.module";
import { wikiPages } from "../db/schema";
import { ClusterJobs } from "../cluster/cluster-jobs.service";
import { SettingsService } from "../settings/settings.service";
import { NotificationsService } from "../notifications/notifications.service";

export interface WikiReviewRun {
  /** Owners who were sent a notice. */
  notified: number;
  /** Pages announced to them. */
  pages: number;
  /** Pages flagged without a notice because they had been due for a long time already. */
  silent: number;
}

/**
 * Tells a page's owner, once, that it has gone a long time without an edit or a "still correct" check. Each page is CLAIMED
 * by one conditional UPDATE on `review_notified_at` before anything is sent, so two nodes never announce it twice, and the
 * flag only counts while it is newer than the page's last edit or review (`wikiReviewNotice`), so it needs no resetting.
 * One message per owner per run, however many of their pages came due. Pages that were already overdue when the check was
 * first on are flagged without a message (the rule is in `wikiReviewNotice`).
 */
@Injectable()
export class WikiReview implements OnModuleInit {
  private readonly logger = new Logger(WikiReview.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jobs: ClusterJobs,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.jobs.register({ name: "wiki-review", everyMs: 60 * 60_000, initialDelayMs: 90_000, run: async () => void (await this.run()) });
  }

  async run(now: Date = new Date()): Promise<WikiReviewRun> {
    const result: WikiReviewRun = { notified: 0, pages: 0, silent: 0 };
    const defaultDays = wikiReviewDays(await this.settings.get(WIKI_REVIEW_DAYS_KEY).catch(() => undefined));
    const rows = await this.db
      .select({
        id: wikiPages.id,
        title: wikiPages.title,
        ownerUserId: wikiPages.ownerUserId,
        updatedAt: wikiPages.updatedAt,
        lastReviewedAt: wikiPages.lastReviewedAt,
        reviewIntervalDays: wikiPages.reviewIntervalDays,
        reviewNotifiedAt: wikiPages.reviewNotifiedAt,
      })
      .from(wikiPages);

    const byOwner = new Map<string, Array<{ id: string; title: string }>>();
    for (const r of rows) {
      const state = wikiReviewState(r, defaultDays, now);
      const notice = wikiReviewNotice(state, r.reviewNotifiedAt, now);
      if (!notice) continue;
      const claimed = await this.db
        .update(wikiPages)
        .set({ reviewNotifiedAt: now })
        .where(and(eq(wikiPages.id, r.id), or(isNull(wikiPages.reviewNotifiedAt), lt(wikiPages.reviewNotifiedAt, state.confirmedAt))))
        .returning({ id: wikiPages.id });
      if (claimed.length === 0) continue;
      if (notice === "silent") {
        result.silent++;
        continue;
      }
      const list = byOwner.get(r.ownerUserId) ?? [];
      list.push({ id: r.id, title: r.title });
      byOwner.set(r.ownerUserId, list);
    }

    for (const [ownerId, pages] of byOwner) {
      const one = pages.length === 1 ? pages[0]! : null;
      await this.notifications.createMany([
        {
          recipientUserId: ownerId,
          kind: "wiki.review_due",
          title: one ? `Wiki page may be out of date: ${one.title}` : `${pages.length} of your wiki pages may be out of date`,
          body: one
            ? "Nobody has edited or confirmed it for a while. Open it and mark it as still correct, or update it."
            : pages
                .slice(0, 5)
                .map((p) => p.title)
                .join(", ") + (pages.length > 5 ? ", and more" : ""),
          link: one ? `/wiki/${one.id}` : "/wiki/review?scope=mine",
        },
      ]);
      result.notified++;
      result.pages += pages.length;
    }
    if (result.pages > 0) this.logger.log(`wiki review: told ${result.notified} owner(s) about ${result.pages} page(s)`);
    return result;
  }
}
