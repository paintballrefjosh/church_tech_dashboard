import { Injectable, Inject, NotFoundException } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { savedViews } from "../db/schema";

const ALLOWED_RESOURCES = ["ticket", "wiki_page", "note"] as const;
export type SavedViewResource = (typeof ALLOWED_RESOURCES)[number];

export function isSavedViewResource(s: string): s is SavedViewResource {
  return (ALLOWED_RESOURCES as readonly string[]).includes(s);
}

@Injectable()
export class SavedViewsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  list(userId: string, resourceType: SavedViewResource) {
    return this.db
      .select()
      .from(savedViews)
      .where(and(eq(savedViews.userId, userId), eq(savedViews.resourceType, resourceType)))
      .orderBy(asc(savedViews.name));
  }

  async create(userId: string, input: { resourceType: SavedViewResource; name: string; query: Record<string, string> }) {
    const [row] = await this.db
      .insert(savedViews)
      .values({
        userId,
        resourceType: input.resourceType,
        name: input.name.trim(),
        query: input.query as never,
      })
      .returning();
    if (!row) throw new Error("Insert failed");
    return row;
  }

  async update(userId: string, id: string, input: { name?: string; query?: Record<string, string> }) {
    const [row] = await this.db
      .update(savedViews)
      .set({
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.query !== undefined ? { query: input.query as never } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(savedViews.id, id), eq(savedViews.userId, userId)))
      .returning();
    if (!row) throw new NotFoundException("Saved view not found");
    return row;
  }

  async delete(userId: string, id: string) {
    const [row] = await this.db
      .delete(savedViews)
      .where(and(eq(savedViews.id, id), eq(savedViews.userId, userId)))
      .returning();
    if (!row) throw new NotFoundException("Saved view not found");
    return row;
  }
}
