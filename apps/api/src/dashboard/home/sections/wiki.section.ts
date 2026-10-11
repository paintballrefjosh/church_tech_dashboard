import { Inject, Injectable } from "@nestjs/common";
import { desc, inArray } from "drizzle-orm";
import { PERMISSIONS, sectionOff, sectionOk, type Section, type WikiDigest } from "@church/shared";
import { DB, type Db } from "../../../db/db.module";
import { wikiRevisions } from "../../../db/schema";
import { WikiService } from "../../../wiki/wiki.service";
import type { HomeContext, SectionBuilder } from "../home.types";
import { loadUserNames } from "../names";

export const WIKI_RECENT_LIMIT = 6;

@Injectable()
export class HomeWikiSection implements SectionBuilder<WikiDigest> {
  constructor(
    private readonly wiki: WikiService,
    @Inject(DB) private readonly db: Db,
  ) {}

  async build(ctx: HomeContext): Promise<Section<WikiDigest>> {
    if (!ctx.user.permissions.includes(PERMISSIONS.WIKI_READ_OWN)) return sectionOff("forbidden");
    // WikiService.list applies page ACLs and orders by updatedAt, newest first.
    const pages = await this.wiki.list(ctx.user, { limit: WIKI_RECENT_LIMIT });
    if (pages.length === 0) return sectionOk({ recent: [] });

    // Who last changed each page: the editor of its newest revision, else its owner.
    const revisions = await this.db
      .select({ pageId: wikiRevisions.pageId, editorUserId: wikiRevisions.editorUserId })
      .from(wikiRevisions)
      .where(inArray(wikiRevisions.pageId, pages.map((p) => p.id)))
      .orderBy(desc(wikiRevisions.createdAt));
    const editorOf = new Map<string, string | null>();
    for (const r of revisions) if (!editorOf.has(r.pageId)) editorOf.set(r.pageId, r.editorUserId);
    const names = await loadUserNames(this.db, [...editorOf.values(), ...pages.map((p) => p.ownerUserId)]);

    return sectionOk({
      recent: pages.map((p) => {
        const editor = editorOf.get(p.id) ?? p.ownerUserId;
        return {
          id: p.id,
          title: p.title,
          href: `/wiki/${p.id}`,
          updatedAt: p.updatedAt.toISOString(),
          updatedByName: names.get(editor) ?? null,
        };
      }),
    });
  }
}
