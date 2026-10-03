import {
  Injectable,
  Inject,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from "@nestjs/common";
import { and, asc, desc, eq, ilike, inArray, or, type SQL } from "drizzle-orm";
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
  type CreateWikiPageInput,
  type UpdateWikiPageInput,
  type WikiAclEntry,
  type WikiPageListQuery,
  type WikiTreeNode,
} from "@church/shared";
import type { AuthenticatedUser } from "../auth/current-user.decorator";
import { AttachmentsService } from "../attachments/attachments.service";
import { SearchService, searchDocId } from "../search/search.service";
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
  ) {}

  private async indexPage(row: typeof wikiPages.$inferSelect) {
    // Pull the ACL groups so the search filter can scope correctly. Empty
    // when the page is public.
    const acl =
      row.visibility === "group"
        ? await this.db
            .select({ groupId: wikiPageAcl.groupId })
            .from(wikiPageAcl)
            .where(eq(wikiPageAcl.pageId, row.id))
        : [];
    void this.search.upsert({
      id: searchDocId("wiki", row.id),
      kind: "wiki",
      resourceId: row.id,
      ownerUserId: row.ownerUserId,
      visibility: row.visibility as "public" | "group",
      aclGroupIds: acl.map((a) => a.groupId),
      title: row.title,
      body: row.body,
      updatedAt: row.updatedAt.toISOString(),
    });
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

    return { page, acl: aclRows, canEdit, canDelete, updatedBy: lastEditor ?? null };
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
    });
    return page;
  }

  async update(user: AuthenticatedUser, id: string, input: UpdateWikiPageInput) {
    const ok = await this.canWritePage(user, id);
    if (!ok) throw new ForbiddenException("Cannot edit this page");
    const [existing] = await this.db
      .select()
      .from(wikiPages)
      .where(eq(wikiPages.id, id))
      .limit(1);
    if (!existing) throw new NotFoundException("Wiki page not found");

    // visibility + ACL changes are owner/admin-only — collaborators with edit
    // access don't get to widen or narrow who else can see the page.
    const wantsAclChange = input.visibility !== undefined || input.acl !== undefined;
    if (wantsAclChange && existing.ownerUserId !== user.id && !this.canWriteAny(user)) {
      throw new ForbiddenException("Only the page owner can change visibility or ACL");
    }

    const patch: Partial<typeof wikiPages.$inferInsert> = { updatedAt: new Date() };
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
    void this.search.remove(searchDocId("wiki", id));
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
  async revertToRevision(user: AuthenticatedUser, pageId: string, revisionId: string) {
    const ok = await this.canWritePage(user, pageId);
    if (!ok) throw new ForbiddenException("Cannot edit this page");
    const [rev] = await this.db
      .select()
      .from(wikiRevisions)
      .where(and(eq(wikiRevisions.pageId, pageId), eq(wikiRevisions.id, revisionId)))
      .limit(1);
    if (!rev) throw new NotFoundException("Revision not found");

    const [page] = await this.db
      .update(wikiPages)
      .set({ title: rev.title, body: rev.body, updatedAt: new Date() })
      .where(eq(wikiPages.id, pageId))
      .returning();
    if (!page) throw new NotFoundException("Wiki page not found");

    await this.db.insert(wikiRevisions).values({
      pageId,
      title: rev.title,
      body: rev.body,
      editorUserId: user.id,
      summary: `Reverted to revision from ${rev.createdAt.toISOString()}`,
    });
    void this.indexPage(page);
    return page;
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
