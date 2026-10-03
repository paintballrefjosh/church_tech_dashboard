import { Injectable, Inject, NotFoundException, BadRequestException } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { wikiFolders } from "../db/schema";
import type { CreateWikiFolderInput, UpdateWikiFolderInput } from "@church/shared";

/**
 * Folders are pure organizational containers for the wiki tree — no body, no
 * per-folder ACL. Any wiki:create holder can create/rename/move/delete them;
 * they don't gate content access (that stays on the page itself), so the
 * blast radius of a mistake is just "things moved," never "things exposed."
 */
@Injectable()
export class WikiFoldersService {
  constructor(@Inject(DB) private readonly db: Db) {}

  list() {
    return this.db
      .select()
      .from(wikiFolders)
      .orderBy(asc(wikiFolders.name));
  }

  async create(input: CreateWikiFolderInput) {
    if (input.parentFolderId) await this.assertValidParent(input.parentFolderId, null);
    const [folder] = await this.db
      .insert(wikiFolders)
      .values({ name: input.name.trim(), parentFolderId: input.parentFolderId ?? null })
      .returning();
    if (!folder) throw new Error("Insert failed");
    return folder;
  }

  async update(id: string, input: UpdateWikiFolderInput) {
    const patch: Partial<typeof wikiFolders.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.parentFolderId !== undefined) {
      if (input.parentFolderId) await this.assertValidParent(input.parentFolderId, id);
      patch.parentFolderId = input.parentFolderId;
    }
    const [folder] = await this.db
      .update(wikiFolders)
      .set(patch)
      .where(eq(wikiFolders.id, id))
      .returning();
    if (!folder) throw new NotFoundException("Folder not found");
    return folder;
  }

  /**
   * Deletes the folder. Sub-folders and pages that lived in it are promoted
   * to root by the DB's ON DELETE SET NULL — no cascade-delete, no orphaned
   * content, no separate "move children out first" step required.
   */
  async delete(id: string) {
    const [row] = await this.db.delete(wikiFolders).where(eq(wikiFolders.id, id)).returning();
    if (!row) throw new NotFoundException("Folder not found");
    return { ok: true, id };
  }

  /** Used by WikiService when a page is filed into a folder. */
  async assertExists(id: string): Promise<void> {
    const [row] = await this.db
      .select({ id: wikiFolders.id })
      .from(wikiFolders)
      .where(eq(wikiFolders.id, id))
      .limit(1);
    if (!row) throw new BadRequestException("Parent folder not found");
  }

  /**
   * Mirrors WikiService.assertValidParent: the candidate parent must exist,
   * not be the folder itself, and not be one of its own descendants. Folders
   * only ever nest under other folders (never under a page), so this walk
   * never crosses into wiki_pages and can't collide with the page-tree cycle
   * check.
   */
  private async assertValidParent(parentFolderId: string, selfId: string | null): Promise<void> {
    if (selfId && parentFolderId === selfId) {
      throw new BadRequestException("A folder can't be its own parent");
    }
    const seen = new Set<string>(selfId ? [selfId] : []);
    let cursor: string | null = parentFolderId;
    let depth = 0;
    while (cursor && depth < 64) {
      if (seen.has(cursor)) {
        throw new BadRequestException("That would create a parent cycle");
      }
      seen.add(cursor);
      const [row] = await this.db
        .select({ id: wikiFolders.id, parentFolderId: wikiFolders.parentFolderId })
        .from(wikiFolders)
        .where(eq(wikiFolders.id, cursor))
        .limit(1);
      if (!row) throw new BadRequestException("Parent folder not found");
      cursor = row.parentFolderId;
      depth++;
    }
  }
}
