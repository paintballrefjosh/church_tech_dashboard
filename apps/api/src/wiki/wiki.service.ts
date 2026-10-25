import {
  Injectable,
  Inject,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import { and, asc, desc, eq, ilike, inArray, ne, or, type SQL } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import {
  wikiPages,
  wikiPageAcl,
  wikiRevisions,
  wikiFolders,
  groupMemberships,
  tagAssignments,
  users,
} from "../db/schema";
import {
  PERMISSIONS,
  WIKI_REVIEW_DAYS_KEY,
  extractWikiLinks,
  wikiLinkContext,
  wikiReviewDays,
  wikiReviewState,
  type CreateWikiPageInput,
  type UpdateWikiPageInput,
  type WikiAclEntry,
  type WikiPageListQuery,
  type WikiReviewQuery,
  type WikiTreeNode,
} from "@church/shared";
import type { AuthenticatedUser } from "../auth/current-user.decorator";
import { AttachmentsService } from "../attachments/attachments.service";
import { SearchService } from "../search/search.service";
import { SettingsService } from "../settings/settings.service";
import { ActivityService } from "../activity/activity.service";
import { MentionsService } from "../mentions/mentions.service";
import { WikiFoldersService } from "./wiki-folders.service";

/**
 * Wiki access checks (per page):
 *   read:
 *     - wiki:read:any         → yes
 *     - owner                 → yes
 *     - visibility=public     → yes (any signed-in user)
 *     - in any ACL group      → yes
 *   write:
 *     - wiki:write:any        → yes
 *     - owner                 → yes
 *     - in an ACL group whose can_edit=true → yes
 *   delete:
 *     - wiki:delete:any       → yes
 *     - owner + wiki:delete:own → yes
 *
 * NotFoundException is preferred over ForbiddenException for read attempts so
 * we don't disclose the existence of pages a user has no business knowing
 * about.
 */
@Injectable()
export class WikiService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly attachments: AttachmentsService,
    private readonly search: SearchService,
    private readonly activity: ActivityService,
    private readonly mentions: MentionsService,
    private readonly folders: WikiFoldersService,
    private readonly settings: SettingsService,
  ) {}

  /** The site-wide review interval in days (0 = the check is off). */
  async reviewDefaultDays(): Promise<number> {
    return wikiReviewDays(await this.settings.get(WIKI_REVIEW_DAYS_KEY).catch(() => undefined));
  }

  /** The page was created, edited or had its access changed: refresh its search document on every node. */
  private indexPage(row: typeof wikiPages.$inferSelect): void {
    void this.search.changed("wiki", row.id);
  }

  /**
   * SQL predicate matching the rows of `wiki_pages` the given user is allowed
   * to read. Composes as a subquery on the WHERE clause — no JS-side ID
   * enumeration step, no `IN (large list)`. Returns `undefined` when the user
   * has WIKI_READ_ANY so the caller can skip the filter entirely.
   */
  private readablePredicate(user: AuthenticatedUser): SQL | undefined {
    if (user.permissions.includes(PERMISSIONS.WIKI_READ_ANY)) return undefined;
    return or(
      eq(wikiPages.visibility, "public"),
      eq(wikiPages.ownerUserId, user.id),
      inArray(
        wikiPages.id,
        this.db
          .select({ id: wikiPageAcl.pageId })
          .from(wikiPageAcl)
          .innerJoin(groupMemberships, eq(groupMemberships.groupId, wikiPageAcl.groupId))
          .where(eq(groupMemberships.userId, user.id)),
      ),
    )!;
  }

  private canDeleteAny(user: AuthenticatedUser) {
    return user.permissions.includes(PERMISSIONS.WIKI_ADMIN);
  }
  private canReadAny(user: AuthenticatedUser) {
    return user.permissions.includes(PERMISSIONS.WIKI_READ_ANY);
  }
  private canWriteAny(user: AuthenticatedUser) {
    return user.permissions.includes(PERMISSIONS.WIKI_ADMIN);
  }

  async canReadPage(user: AuthenticatedUser, pageId: string): Promise<boolean> {
    if (this.canReadAny(user)) return true;
    // Page lookup and the ACL check are independent — run them in parallel.
    // The ACL check joins the page's ACL rows to the user's group memberships
    // in one query, replacing the old fetch-my-groups-then-match round-trip.
    const [pageRows, aclHit] = await Promise.all([
      this.db
        .select({ ownerUserId: wikiPages.ownerUserId, visibility: wikiPages.visibility })
        .from(wikiPages)
        .where(eq(wikiPages.id, pageId))
        .limit(1),
      this.db
        .select({ pageId: wikiPageAcl.pageId })
        .from(wikiPageAcl)
        .innerJoin(groupMemberships, eq(groupMemberships.groupId, wikiPageAcl.groupId))
        .where(and(eq(wikiPageAcl.pageId, pageId), eq(groupMemberships.userId, user.id)))
        .limit(1),
    ]);
    const page = pageRows[0];
    if (!page) return false;
    if (page.ownerUserId === user.id) return true;
    if (page.visibility === "public") return true;
    return aclHit.length > 0;
  }

  /**
   * A mention carries the page's title and opening text, so only someone who could open the page is told: the Wiki
   * module at all, then the page's own visibility and access list.
   */
  private async mayReadForMention(user: AuthenticatedUser, pageId: string): Promise<boolean> {
    if (!user.permissions.includes(PERMISSIONS.WIKI_READ_OWN)) return false;
    return this.canReadPage(user, pageId);
  }

  async canWritePage(user: AuthenticatedUser, pageId: string): Promise<boolean> {
    if (this.canWriteAny(user)) return true;
    const [pageRows, aclHit] = await Promise.all([
      this.db
        .select({ ownerUserId: wikiPages.ownerUserId })
        .from(wikiPages)
        .where(eq(wikiPages.id, pageId))
        .limit(1),
      this.db
        .select({ pageId: wikiPageAcl.pageId })
        .from(wikiPageAcl)
        .innerJoin(groupMemberships, eq(groupMemberships.groupId, wikiPageAcl.groupId))
        .where(
          and(
            eq(wikiPageAcl.pageId, pageId),
            eq(groupMemberships.userId, user.id),
            eq(wikiPageAcl.canEdit, true),
          ),
        )
        .limit(1),
    ]);
    const page = pageRows[0];
    if (!page) return false;
    if (page.ownerUserId === user.id) return true;
    return aclHit.length > 0;
  }

  async list(user: AuthenticatedUser, query: WikiPageListQuery) {
    const conds: SQL[] = [];
    const aclPredicate = this.readablePredicate(user);
    if (aclPredicate) conds.push(aclPredicate);
    if (query.q) {
      const like = `%${query.q.replace(/[%_]/g, "\\$&")}%`;
      conds.push(or(ilike(wikiPages.title, like), ilike(wikiPages.body, like))!);
    }
    if (query.tagId) {
      conds.push(
        inArray(
          wikiPages.id,
          this.db
            .select({ id: tagAssignments.resourceId })
            .from(tagAssignments)
            .where(
              and(
                eq(tagAssignments.resourceType, "wiki_page"),
                eq(tagAssignments.tagId, query.tagId),
              ),
            ),
        ),
      );
    }
    return this.db
      .select()
      .from(wikiPages)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(wikiPages.updatedAt))
      .limit(query.limit);
  }

  /** Which of `ids` this person may read: one query on the ids asked about, no page bodies. */
  async readableIds(user: AuthenticatedUser, ids: readonly string[]): Promise<Set<string>> {
    const want = [...new Set(ids)].filter(Boolean);
    if (want.length === 0) return new Set();
    const acl = this.readablePredicate(user);
    const rows = await this.db
      .select({ id: wikiPages.id })
      .from(wikiPages)
      .where(acl ? and(inArray(wikiPages.id, want), acl) : inArray(wikiPages.id, want));
    return new Set(rows.map((r) => r.id));
  }

  async getWithAcl(user: AuthenticatedUser, id: string) {
    // Single round trip for all three reads; access checks then compute in JS
    // from the already-fetched rows. Replaces the previous 5+ sequential
    // queries (canRead × 3 + page + acl + canWrite × 3).
    const [pageRows, aclRows, myGroupRows] = await Promise.all([
      this.db.select().from(wikiPages).where(eq(wikiPages.id, id)).limit(1),
      this.db
        .select({ groupId: wikiPageAcl.groupId, canEdit: wikiPageAcl.canEdit })
        .from(wikiPageAcl)
        .where(eq(wikiPageAcl.pageId, id)),
      this.db
        .select({ groupId: groupMemberships.groupId })
        .from(groupMemberships)
        .where(eq(groupMemberships.userId, user.id)),
    ]);
    const [page] = pageRows;
    if (!page) throw new NotFoundException("Wiki page not found");

    const myGroups = new Set(myGroupRows.map((r) => r.groupId));
    const aclMatch = aclRows.filter((r) => myGroups.has(r.groupId));

    const canReadAny = this.canReadAny(user);
    const canRead =
      canReadAny ||
      page.ownerUserId === user.id ||
      page.visibility === "public" ||
      aclMatch.length > 0;
    if (!canRead) throw new NotFoundException("Wiki page not found");

    const canEdit =
      this.canWriteAny(user) ||
      page.ownerUserId === user.id ||
      aclMatch.some((r) => r.canEdit);
    const canDelete = this.canDeleteAny(user) || page.ownerUserId === user.id;

    // Who last saved the page — the editor on the most recent revision row
    // (create() and update() both insert one, so this always tracks
    // page.updatedAt without needing a denormalized column on wiki_pages).
    const [lastEditor] = await this.db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(wikiRevisions)
      .innerJoin(users, eq(users.id, wikiRevisions.editorUserId))
      .where(eq(wikiRevisions.pageId, id))
      .orderBy(desc(wikiRevisions.createdAt))
      .limit(1);

    const [reviewer] = page.lastReviewedBy
      ? await this.db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.id, page.lastReviewedBy)).limit(1)
      : [];
    const state = wikiReviewState(page, await this.reviewDefaultDays(), new Date());
    const review = {
      intervalDays: state.intervalDays,
      usingDefault: state.usingDefault,
      confirmedAt: state.confirmedAt.toISOString(),
      dueAt: state.dueAt ? state.dueAt.toISOString() : null,
      needsReview: state.needsReview,
      daysOverdue: state.daysOverdue,
      lastReviewedAt: page.lastReviewedAt ? page.lastReviewedAt.toISOString() : null,
      reviewedBy: reviewer ?? null,
    };

    // canManage: the owner or a wiki admin (visibility, access, how often the page is reviewed); isAdmin: wiki admin (templates).
    return { page, acl: aclRows, canEdit, canDelete, canManage: canDelete, isAdmin: this.canWriteAny(user), updatedBy: lastEditor ?? null, review };
  }

  /**
   * Pages (that the caller may read) which link to this one. Found by looking for the page's address in other bodies and
   * then confirming it is a real link, so nothing is stored that could fall out of step with the text, an edit shows at
   * once on every node, and a restore needs no rebuild. A page the caller cannot read is never named.
   */
  async backlinks(user: AuthenticatedUser, id: string) {
    await this.assertReadable(user, id);
    // A reader with wiki:read:any passes the check above for an id that does not exist.
    const [exists] = await this.db.select({ id: wikiPages.id }).from(wikiPages).where(eq(wikiPages.id, id)).limit(1);
    if (!exists) throw new NotFoundException("Wiki page not found");
    const pageId = id.toLowerCase();
    const readable = this.readablePredicate(user);
    const rows = await this.db
      .select({ id: wikiPages.id, title: wikiPages.title, body: wikiPages.body, updatedAt: wikiPages.updatedAt })
      .from(wikiPages)
      .where(and(ilike(wikiPages.body, `%/wiki/${pageId}%`), ne(wikiPages.id, id), readable));
    return rows
      .filter((r) => extractWikiLinks(r.body).includes(pageId))
      .map((r) => ({ id: r.id, title: r.title, updatedAt: r.updatedAt, context: wikiLinkContext(r.body, pageId) }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  /** Pages the caller may read that are due for another look, the most overdue first. */
  async reviewList(user: AuthenticatedUser, query: WikiReviewQuery) {
    const defaultDays = await this.reviewDefaultDays();
    const conds: SQL[] = [];
    const readable = this.readablePredicate(user);
    if (readable) conds.push(readable);
    if (query.scope === "mine") conds.push(eq(wikiPages.ownerUserId, user.id));
    const rows = await this.db
      .select({
        id: wikiPages.id,
        title: wikiPages.title,
        ownerUserId: wikiPages.ownerUserId,
        ownerName: users.name,
        ownerEmail: users.email,
        updatedAt: wikiPages.updatedAt,
        lastReviewedAt: wikiPages.lastReviewedAt,
        reviewIntervalDays: wikiPages.reviewIntervalDays,
      })
      .from(wikiPages)
      .leftJoin(users, eq(users.id, wikiPages.ownerUserId))
      .where(conds.length ? and(...conds) : undefined);
    const now = new Date();
    const due = rows
      .map((r) => ({ row: r, state: wikiReviewState(r, defaultDays, now) }))
      .filter((x) => x.state.needsReview)
      .sort((a, b) => a.state.dueAt!.getTime() - b.state.dueAt!.getTime());
    return {
      total: due.length,
      items: due.slice(0, query.limit).map(({ row, state }) => ({
        id: row.id,
        title: row.title,
        ownerUserId: row.ownerUserId,
        owner: row.ownerName ?? row.ownerEmail,
        confirmedAt: state.confirmedAt.toISOString(),
        dueAt: state.dueAt!.toISOString(),
        daysOverdue: state.daysOverdue,
        intervalDays: state.intervalDays,
      })),
    };
  }

  /**
   * "I checked this page and it is still right." Not an edit: it makes no revision and leaves `updatedAt` (and so "updated
   * by") alone. Whoever may edit the page may confirm it.
   */
  async markReviewed(user: AuthenticatedUser, id: string) {
    await this.assertReadable(user, id);
    if (!(await this.canWritePage(user, id))) throw new ForbiddenException("Cannot edit this page");
    const [page] = await this.db
      .update(wikiPages)
      .set({ lastReviewedAt: new Date(), lastReviewedBy: user.id })
      .where(eq(wikiPages.id, id))
      .returning();
    if (!page) throw new NotFoundException("Wiki page not found");
    const state = wikiReviewState(page, await this.reviewDefaultDays(), new Date());
    return {
      id: page.id,
      lastReviewedAt: page.lastReviewedAt!.toISOString(),
      lastReviewedBy: user.id,
      needsReview: state.needsReview,
      dueAt: state.dueAt ? state.dueAt.toISOString() : null,
    };
  }

  async create(user: AuthenticatedUser, input: CreateWikiPageInput) {
    if (input.parentId) await this.assertValidParent(input.parentId, null);
    if (input.parentFolderId) await this.folders.assertExists(input.parentFolderId);
    const [page] = await this.db
      .insert(wikiPages)
      .values({
        title: input.title.trim(),
        body: input.body,
        ownerUserId: user.id,
        visibility: input.visibility,
        parentId: input.parentId ?? null,
        parentFolderId: input.parentFolderId ?? null,
      })
      .returning();
    if (!page) throw new Error("Insert failed");
    if (input.acl.length) await this.replaceAcl(page.id, input.acl);
    await this.db.insert(wikiRevisions).values({
      pageId: page.id,
      title: page.title,
      body: page.body,
      editorUserId: user.id,
      summary: "Initial revision",
    });
    void this.indexPage(page);
    void this.activity.record({
      actorUserId: user.id,
      action: "wiki.created",
      resourceType: "wiki_page",
      resourceId: page.id,
      title: page.title,
      summary: page.body.slice(0, 200),
      link: `/wiki/${page.id}`,
    });
    void this.mentions.notify({
      body: page.body,
      excludeUserId: user.id,
      title: `Mentioned in wiki: ${page.title}`,
      summary: page.body,
      link: `/wiki/${page.id}`,
      canSee: (u) => this.mayReadForMention(u, page.id),
    });
    return page;
  }

  /**
   * `expectedUpdatedAt` (optional) is an edit-conflict guard: the update is
   * refused with 409 when the page changed since the caller read it, so an
   * agent editing from a stale copy can't overwrite someone else's edit.
   */
  async update(
    user: AuthenticatedUser,
    id: string,
    input: UpdateWikiPageInput,
    opts: { expectedUpdatedAt?: Date } = {},
  ) {
    const ok = await this.canWritePage(user, id);
    if (!ok) throw new ForbiddenException("Cannot edit this page");
    const [existing] = await this.db
      .select()
      .from(wikiPages)
      .where(eq(wikiPages.id, id))
      .limit(1);
    if (!existing) throw new NotFoundException("Wiki page not found");
    if (opts.expectedUpdatedAt && existing.updatedAt.getTime() !== opts.expectedUpdatedAt.getTime()) {
      throw new ConflictException(
        `Page changed since it was read (now updatedAt ${existing.updatedAt.toISOString()}). Re-read it and apply your edit again.`,
      );
    }

    // visibility + ACL changes are owner/admin-only — collaborators with edit
    // access don't get to widen or narrow who else can see the page.
    const wantsAclChange = input.visibility !== undefined || input.acl !== undefined;
    if (wantsAclChange && existing.ownerUserId !== user.id && !this.canWriteAny(user)) {
      throw new ForbiddenException("Only the page owner can change visibility or ACL");
    }
    // How often a page is checked is the owner's call too (an editor could otherwise silence the reminder).
    if (input.reviewIntervalDays !== undefined && existing.ownerUserId !== user.id && !this.canWriteAny(user)) {
      throw new ForbiddenException("Only the page owner can change how often it is reviewed");
    }

    // Changing only how often the page is reviewed is not an edit of the page.
    const touchesPage = Object.entries(input).some(([k, v]) => v !== undefined && k !== "reviewIntervalDays");
    const patch: Partial<typeof wikiPages.$inferInsert> = touchesPage ? { updatedAt: new Date() } : {};
    if (input.reviewIntervalDays !== undefined) patch.reviewIntervalDays = input.reviewIntervalDays;
    if (input.title !== undefined) patch.title = input.title.trim();
    if (input.body !== undefined) patch.body = input.body;
    if (input.visibility !== undefined) patch.visibility = input.visibility;
    // parentId (subpage-of-page) and parentFolderId (in-folder) are mutually
    // exclusive on the row. The Zod schema rejects a request that sets both
    // explicitly; when a request sets only one of them, clear the other here
    // so e.g. moving a page into a folder also detaches it as a subpage.
    if (input.parentId !== undefined) {
      if (input.parentId) await this.assertValidParent(input.parentId, id);
      patch.parentId = input.parentId;
      if (input.parentFolderId === undefined && input.parentId) patch.parentFolderId = null;
    }
    if (input.parentFolderId !== undefined) {
      if (input.parentFolderId) await this.folders.assertExists(input.parentFolderId);
      patch.parentFolderId = input.parentFolderId;
      if (input.parentId === undefined && input.parentFolderId) patch.parentId = null;
    }
    if (Object.keys(patch).length === 0) patch.updatedAt = new Date();
    const [page] = await this.db
      .update(wikiPages)
      .set(patch)
      .where(eq(wikiPages.id, id))
      .returning();
    if (!page) throw new NotFoundException("Wiki page not found");

    if (input.acl !== undefined) await this.replaceAcl(id, input.acl);

    const titleChanged = input.title !== undefined && input.title !== existing.title;
    const bodyChanged = input.body !== undefined && input.body !== existing.body;
    if (titleChanged || bodyChanged) {
      await this.db.insert(wikiRevisions).values({
        pageId: id,
        title: page.title,
        body: page.body,
        editorUserId: user.id,
        summary: input.summary ?? null,
      });
    }
    void this.indexPage(page);
    // Only fire mention notifications when the body actually changed — a
    // title-only rename or ACL tweak isn't worth pinging mentioned users.
    // The recipientsForPageChange fan-out already covers wiki-update notifs
    // for the wider audience; mention is the targeted layer on top.
    if (bodyChanged) {
      void this.mentions.notify({
        body: page.body,
        excludeUserId: user.id,
        title: `Mentioned in wiki: ${page.title}`,
        summary: page.body,
        link: `/wiki/${page.id}`,
        canSee: (u) => this.mayReadForMention(u, page.id),
      });
    }
    return page;
  }

  async delete(user: AuthenticatedUser, id: string) {
    const [page] = await this.db.select().from(wikiPages).where(eq(wikiPages.id, id)).limit(1);
    if (!page) throw new NotFoundException("Wiki page not found");
    const canDelete = this.canDeleteAny(user) || page.ownerUserId === user.id;
    if (!canDelete) throw new ForbiddenException("Cannot delete this page");
    // Cascade attachments (MinIO + DB) before dropping the page row.
    await this.attachments.deleteAllForParent("wiki_page", id);
    await this.db.delete(wikiPages).where(eq(wikiPages.id, id));
    void this.search.changed("wiki", id);
    return { ok: true, id };
  }

  /** Visibility check used by attachment routes. */
  async assertReadable(user: AuthenticatedUser, id: string): Promise<void> {
    const ok = await this.canReadPage(user, id);
    if (!ok) throw new NotFoundException("Wiki page not found");
  }

  /**
   * Verify a candidate parent_id is sane: the parent page must exist, must
   * not be the page itself, and must not be one of the page's descendants
   * (would create a cycle). Walks up the parent chain; bails after a depth
   * cap to avoid runaway loops if the DB ever ends up in a cycle anyway.
   */
  private async assertValidParent(parentId: string, selfId: string | null): Promise<void> {
    if (selfId && parentId === selfId) {
      throw new BadRequestException("A page can't be its own parent");
    }
    const seen = new Set<string>(selfId ? [selfId] : []);
    let cursor: string | null = parentId;
    let depth = 0;
    while (cursor && depth < 64) {
      if (seen.has(cursor)) {
        throw new BadRequestException("That would create a parent cycle");
      }
      seen.add(cursor);
      const [row] = await this.db
        .select({ id: wikiPages.id, parentId: wikiPages.parentId })
        .from(wikiPages)
        .where(eq(wikiPages.id, cursor))
        .limit(1);
      if (!row) throw new BadRequestException("Parent page not found");
      cursor = row.parentId;
      depth++;
    }
  }

  /**
   * All folders + readable pages in one flat, discriminated list — the merged
   * tree the web renders. Folders carry no ACL of their own (see wiki.ts), so
   * every folder is included regardless of the user's page-read scope; a page
   * whose folder isn't itself visible still surfaces fine since folders are
   * just navigation, not gates. Keeps the API stateless and the wire payload
   * small — the web builds the actual tree client-side.
   */
  async tree(user: AuthenticatedUser): Promise<WikiTreeNode[]> {
    const aclPredicate = this.readablePredicate(user);
    const [folderRows, pageRows] = await Promise.all([
      this.db
        .select({ id: wikiFolders.id, name: wikiFolders.name, parentFolderId: wikiFolders.parentFolderId })
        .from(wikiFolders)
        .orderBy(asc(wikiFolders.name)),
      this.db
        .select({
          id: wikiPages.id,
          title: wikiPages.title,
          parentId: wikiPages.parentId,
          parentFolderId: wikiPages.parentFolderId,
        })
        .from(wikiPages)
        .where(aclPredicate ?? undefined)
        .orderBy(asc(wikiPages.title)),
    ]);
    return [
      ...folderRows.map((f): WikiTreeNode => ({ kind: "folder", ...f })),
      ...pageRows.map((p): WikiTreeNode => ({ kind: "page", ...p })),
    ];
  }

  /** Edit check used by attachment routes. */
  async assertWritable(user: AuthenticatedUser, id: string): Promise<void> {
    const ok = await this.canWritePage(user, id);
    if (!ok) throw new ForbiddenException("Cannot modify this page");
  }

  async revisions(user: AuthenticatedUser, id: string) {
    const ok = await this.canReadPage(user, id);
    if (!ok) throw new NotFoundException("Wiki page not found");
    return this.db
      .select({
        id: wikiRevisions.id,
        pageId: wikiRevisions.pageId,
        title: wikiRevisions.title,
        body: wikiRevisions.body,
        editorUserId: wikiRevisions.editorUserId,
        editorName: users.name,
        editorEmail: users.email,
        summary: wikiRevisions.summary,
        createdAt: wikiRevisions.createdAt,
      })
      .from(wikiRevisions)
      .leftJoin(users, eq(users.id, wikiRevisions.editorUserId))
      .where(eq(wikiRevisions.pageId, id))
      .orderBy(desc(wikiRevisions.createdAt));
  }

  async getRevision(user: AuthenticatedUser, pageId: string, revisionId: string) {
    const ok = await this.canReadPage(user, pageId);
    if (!ok) throw new NotFoundException("Wiki page not found");
    const [row] = await this.db
      .select()
      .from(wikiRevisions)
      .where(and(eq(wikiRevisions.pageId, pageId), eq(wikiRevisions.id, revisionId)))
      .limit(1);
    if (!row) throw new NotFoundException("Revision not found");
    return row;
  }

  /**
   * Restore an old revision: writes the revision's title+body back onto the
   * page and records a new revision row pointing at the restore action. The
   * old revision row is preserved — restore is additive, never destructive.
   */
  async revertToRevision(
    user: AuthenticatedUser,
    pageId: string,
    revisionId: string,
    opts: { expectedUpdatedAt?: Date } = {},
  ) {
    const ok = await this.canWritePage(user, pageId);
    if (!ok) throw new ForbiddenException("Cannot edit this page");
    const [rev] = await this.db
      .select()
      .from(wikiRevisions)
      .where(and(eq(wikiRevisions.pageId, pageId), eq(wikiRevisions.id, revisionId)))
      .limit(1);
    if (!rev) throw new NotFoundException("Revision not found");
    // Through the ordinary edit: the same conflict guard (a revert must not silently throw away an edit made while
    // the history was open), revision row, search index and @mentions.
    return this.update(
      user,
      pageId,
      { title: rev.title, body: rev.body, summary: `Reverted to revision from ${rev.createdAt.toISOString()}` },
      opts,
    );
  }

  /**
   * Recipients for a page change notification: the owner + every user who is a
   * member of any group on the page's ACL. De-duped. Used by the controller
   * after update/delete to fan out notifications; we don't filter by visibility
   * here because the owner + ACL members are by definition allowed to know
   * the page changed.
   */
  async recipientsForPageChange(pageId: string): Promise<string[]> {
    // Owner lookup and ACL-member expansion are independent — run them in
    // parallel. The member query joins memberships to the page's ACL groups in
    // one round-trip instead of fetching ACL group ids and then querying again.
    const [pageRows, members] = await Promise.all([
      this.db
        .select({ ownerUserId: wikiPages.ownerUserId })
        .from(wikiPages)
        .where(eq(wikiPages.id, pageId))
        .limit(1),
      this.db
        .select({ userId: groupMemberships.userId })
        .from(groupMemberships)
        .innerJoin(wikiPageAcl, eq(wikiPageAcl.groupId, groupMemberships.groupId))
        .where(eq(wikiPageAcl.pageId, pageId)),
    ]);
    const page = pageRows[0];
    if (!page) return [];
    const ids = new Set<string>([page.ownerUserId]);
    for (const m of members) ids.add(m.userId);
    return [...ids];
  }

  private async replaceAcl(pageId: string, acl: WikiAclEntry[]) {
    await this.db.delete(wikiPageAcl).where(eq(wikiPageAcl.pageId, pageId));
    if (!acl.length) return;
    // De-dupe groupId; last entry wins for canEdit.
    const map = new Map<string, boolean>();
    for (const a of acl) map.set(a.groupId, a.canEdit);
    await this.db.insert(wikiPageAcl).values(
      [...map.entries()].map(([groupId, canEdit]) => ({
        pageId,
        groupId,
        canEdit,
      })),
    );
  }
}
