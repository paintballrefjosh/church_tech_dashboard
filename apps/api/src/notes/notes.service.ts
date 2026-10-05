import { Injectable, Inject, NotFoundException, ForbiddenException } from "@nestjs/common";
import { and, eq, desc, ilike, inArray, or, type SQL } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { notes, tagAssignments } from "../db/schema";
import type { CreateNoteInput, UpdateNoteInput, NoteListQuery } from "@church/shared";
import { AttachmentsService } from "../attachments/attachments.service";
import { SearchService } from "../search/search.service";
import { ActivityService } from "../activity/activity.service";

@Injectable()
export class NotesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly attachments: AttachmentsService,
    private readonly search: SearchService,
    private readonly activity: ActivityService,
  ) {}

  async list(ownerUserId: string, query: NoteListQuery) {
    const conditions: SQL[] = [eq(notes.ownerUserId, ownerUserId)];
    conditions.push(eq(notes.archived, query.archived ?? false));
    if (query.q) {
      const like = `%${query.q.replace(/[%_]/g, "\\$&")}%`;
      conditions.push(or(ilike(notes.title, like), ilike(notes.body, like))!);
    }
    if (query.tagId) {
      // Filter to notes whose id appears in tag_assignments for this tag.
      // Subquery is cheaper than a join for this scope size and keeps the
      // outer SELECT shape identical.
      conditions.push(
        inArray(
          notes.id,
          this.db
            .select({ id: tagAssignments.resourceId })
            .from(tagAssignments)
            .where(
              and(eq(tagAssignments.resourceType, "note"), eq(tagAssignments.tagId, query.tagId)),
            ),
        ),
      );
    }
    const rows = await this.db
      .select()
      .from(notes)
      .where(and(...conditions))
      .orderBy(desc(notes.pinned), desc(notes.updatedAt));
    return rows;
  }

  async getById(ownerUserId: string, id: string) {
    const [row] = await this.db.select().from(notes).where(eq(notes.id, id)).limit(1);
    if (!row) throw new NotFoundException("Note not found");
    if (row.ownerUserId !== ownerUserId) throw new ForbiddenException();
    return row;
  }

  async create(ownerUserId: string, input: CreateNoteInput) {
    const [row] = await this.db
      .insert(notes)
      .values({
        ownerUserId,
        title: input.title,
        body: input.body,
        color: input.color,
        pinned: input.pinned,
      })
      .returning();
    if (!row) throw new Error("Insert failed");
    void this.search.changed("note", row.id);
    void this.activity.record({
      actorUserId: ownerUserId,
      action: "note.created",
      resourceType: "note",
      resourceId: row.id,
      title: row.title || "(untitled note)",
      summary: row.body?.slice(0, 200) ?? null,
      link: `/notes`,
    });
    return row;
  }

  async update(ownerUserId: string, id: string, input: UpdateNoteInput) {
    // Owner-check up front so we 404/403 before issuing the UPDATE.
    await this.getById(ownerUserId, id);
    const [row] = await this.db
      .update(notes)
      .set({
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
        ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
        ...(input.archived !== undefined ? { archived: input.archived } : {}),
        ...(input.gridX !== undefined ? { gridX: input.gridX } : {}),
        ...(input.gridY !== undefined ? { gridY: input.gridY } : {}),
        ...(input.gridW !== undefined ? { gridW: input.gridW } : {}),
        ...(input.gridH !== undefined ? { gridH: input.gridH } : {}),
        updatedAt: new Date(),
      })
      .where(eq(notes.id, id))
      .returning();
    if (!row) throw new NotFoundException("Note not found");
    void this.search.changed("note", row.id);
    return row;
  }

  async delete(ownerUserId: string, id: string) {
    await this.getById(ownerUserId, id);
    // Best-effort cascade — drops MinIO objects + DB rows before the note row
    // goes away. Failures here don't block the note delete; orphans get cleaned
    // up later (future reaper job).
    await this.attachments.deleteAllForParent("note", id);
    const [row] = await this.db.delete(notes).where(eq(notes.id, id)).returning();
    void this.search.changed("note", id);
    return row;
  }

  /** Helper so the controller can authorise note-scoped attachment routes. */
  async assertOwner(ownerUserId: string, id: string): Promise<void> {
    await this.getById(ownerUserId, id);
  }
}
