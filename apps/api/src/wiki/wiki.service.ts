import {
  Injectable,
  Inject,
  NotFoundException,
  ForbiddenException,
} from "@nestjs/common";
import { and, desc, eq, ilike, inArray, or, type SQL } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import {
  wikiPages,
  wikiPageAcl,
  wikiRevisions,
  groupMemberships,
} from "../db/schema";
import {
  PERMISSIONS,
  type CreateWikiPageInput,
  type UpdateWikiPageInput,
  type WikiAclEntry,
  type WikiPageListQuery,
} from "@church/shared";
import type { AuthenticatedUser } from "../auth/current-user.decorator";

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
  constructor(@Inject(DB) private readonly db: Db) {}

  private async userGroupIds(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ groupId: groupMemberships.groupId })
      .from(groupMemberships)
      .where(eq(groupMemberships.userId, userId));
    return rows.map((r) => r.groupId);
  }

  /** Page IDs the user can read. Used to scope list queries. */
  private async readablePageIdsForUser(user: AuthenticatedUser): Promise<"all" | Set<string>> {
    if (user.permissions.includes(PERMISSIONS.WIKI_READ_ANY)) return "all";
    // Public pages + own pages + pages where any of my groups is on the ACL.
    const publicAndOwn = await this.db
      .select({ id: wikiPages.id })
      .from(wikiPages)
      .where(or(eq(wikiPages.visibility, "public"), eq(wikiPages.ownerUserId, user.id))!);
    const myGroups = await this.userGroupIds(user.id);
    let aclRows: { pageId: string }[] = [];
    if (myGroups.length) {
      aclRows = await this.db
        .selectDistinct({ pageId: wikiPageAcl.pageId })
        .from(wikiPageAcl)
        .where(inArray(wikiPageAcl.groupId, myGroups));
    }
    return new Set([...publicAndOwn.map((r) => r.id), ...aclRows.map((r) => r.pageId)]);
  }

  private canDeleteAny(user: AuthenticatedUser) {
    return user.permissions.includes(PERMISSIONS.WIKI_DELETE_ANY);
  }
  private canReadAny(user: AuthenticatedUser) {
    return user.permissions.includes(PERMISSIONS.WIKI_READ_ANY);
  }
  private canWriteAny(user: AuthenticatedUser) {
    return user.permissions.includes(PERMISSIONS.WIKI_WRITE_ANY);
  }

  async canReadPage(user: AuthenticatedUser, pageId: string): Promise<boolean> {
    if (this.canReadAny(user)) return true;
    const [page] = await this.db
      .select()
      .from(wikiPages)
      .where(eq(wikiPages.id, pageId))
      .limit(1);
    if (!page) return false;
    if (page.ownerUserId === user.id) return true;
    if (page.visibility === "public") return true;
    const myGroups = await this.userGroupIds(user.id);
    if (myGroups.length === 0) return false;
    const acl = await this.db
      .select()
      .from(wikiPageAcl)
      .where(and(eq(wikiPageAcl.pageId, pageId), inArray(wikiPageAcl.groupId, myGroups)))
      .limit(1);
    return acl.length > 0;
  }

  async canWritePage(user: AuthenticatedUser, pageId: string): Promise<boolean> {
    if (this.canWriteAny(user)) return true;
    const [page] = await this.db
      .select()
      .from(wikiPages)
      .where(eq(wikiPages.id, pageId))
      .limit(1);
    if (!page) return false;
    if (page.ownerUserId === user.id) return true;
    const myGroups = await this.userGroupIds(user.id);
    if (myGroups.length === 0) return false;
    const acl = await this.db
      .select()
      .from(wikiPageAcl)
      .where(
        and(
          eq(wikiPageAcl.pageId, pageId),
          inArray(wikiPageAcl.groupId, myGroups),
          eq(wikiPageAcl.canEdit, true),
        ),
      )
      .limit(1);
    return acl.length > 0;
  }

  async list(user: AuthenticatedUser, query: WikiPageListQuery) {
    const readable = await this.readablePageIdsForUser(user);
    const conds: SQL[] = [];
    if (readable !== "all") {
      if (readable.size === 0) return [];
      conds.push(inArray(wikiPages.id, [...readable]));
    }
    if (query.q) {
      const like = `%${query.q.replace(/[%_]/g, "\\$&")}%`;
      conds.push(or(ilike(wikiPages.title, like), ilike(wikiPages.body, like))!);
    }
    return this.db
      .select()
      .from(wikiPages)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(wikiPages.updatedAt))
      .limit(query.limit);
  }

  async getWithAcl(user: AuthenticatedUser, id: string) {
    const ok = await this.canReadPage(user, id);
    if (!ok) throw new NotFoundException("Wiki page not found");
    const [page] = await this.db.select().from(wikiPages).where(eq(wikiPages.id, id)).limit(1);
    if (!page) throw new NotFoundException("Wiki page not found");
    const acl = await this.db
      .select({ groupId: wikiPageAcl.groupId, canEdit: wikiPageAcl.canEdit })
      .from(wikiPageAcl)
      .where(eq(wikiPageAcl.pageId, id));
    const canEdit = await this.canWritePage(user, id);
    const canDelete = this.canDeleteAny(user) || page.ownerUserId === user.id;
    return { page, acl, canEdit, canDelete };
  }

  async create(user: AuthenticatedUser, input: CreateWikiPageInput) {
    const [page] = await this.db
      .insert(wikiPages)
      .values({
        title: input.title.trim(),
        body: input.body,
        ownerUserId: user.id,
        visibility: input.visibility,
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
    return page;
  }

  async delete(user: AuthenticatedUser, id: string) {
    const [page] = await this.db.select().from(wikiPages).where(eq(wikiPages.id, id)).limit(1);
    if (!page) throw new NotFoundException("Wiki page not found");
    const canDelete = this.canDeleteAny(user) || page.ownerUserId === user.id;
    if (!canDelete) throw new ForbiddenException("Cannot delete this page");
    await this.db.delete(wikiPages).where(eq(wikiPages.id, id));
    return { ok: true, id };
  }

  async revisions(user: AuthenticatedUser, id: string) {
    const ok = await this.canReadPage(user, id);
    if (!ok) throw new NotFoundException("Wiki page not found");
    return this.db
      .select()
      .from(wikiRevisions)
      .where(eq(wikiRevisions.pageId, id))
      .orderBy(desc(wikiRevisions.createdAt));
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
