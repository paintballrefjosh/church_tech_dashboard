import { Injectable, Inject, NotFoundException, ForbiddenException } from "@nestjs/common";
import { and, eq, desc, ilike, or, type SQL } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { notes } from "../db/schema";
import type { CreateNoteInput, UpdateNoteInput, NoteListQuery } from "@church/shared";

@Injectable()
export class NotesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async list(ownerUserId: string, query: NoteListQuery) {
    const conditions: SQL[] = [eq(notes.ownerUserId, ownerUserId)];
    conditions.push(eq(notes.archived, query.archived ?? false));
    if (query.q) {
      const like = `%${query.q.replace(/[%_]/g, "\\$&")}%`;
      conditions.push(or(ilike(notes.title, like), ilike(notes.body, like))!);
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
        updatedAt: new Date(),
      })
      .where(eq(notes.id, id))
      .returning();
    if (!row) throw new NotFoundException("Note not found");
    return row;
  }

  async delete(ownerUserId: string, id: string) {
    await this.getById(ownerUserId, id);
    const [row] = await this.db.delete(notes).where(eq(notes.id, id)).returning();
    return row;
  }
}
