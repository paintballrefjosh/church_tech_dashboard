import {
  Injectable,
  Inject,
  NotFoundException,
  ConflictException,
} from "@nestjs/common";
import { asc, eq, inArray } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { ticketCategories, ticketCategoryAssignments } from "../db/schema";
import type {
  CreateTicketCategoryInput,
  UpdateTicketCategoryInput,
} from "@church/shared";

@Injectable()
export class TicketCategoriesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  list() {
    return this.db.select().from(ticketCategories).orderBy(asc(ticketCategories.name));
  }

  async getById(id: string) {
    const [row] = await this.db
      .select()
      .from(ticketCategories)
      .where(eq(ticketCategories.id, id))
      .limit(1);
    if (!row) throw new NotFoundException("Ticket category not found");
    return row;
  }

  async create(input: CreateTicketCategoryInput) {
    try {
      const [row] = await this.db
        .insert(ticketCategories)
        .values({ name: input.name.trim(), color: input.color })
        .returning();
      if (!row) throw new Error("Insert failed");
      return row;
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        throw new ConflictException("A category with that name already exists");
      }
      throw err;
    }
  }

  async update(id: string, input: UpdateTicketCategoryInput) {
    await this.getById(id);
    const patch: Partial<typeof ticketCategories.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.color !== undefined) patch.color = input.color;
    if (Object.keys(patch).length === 0) return this.getById(id);
    try {
      const [row] = await this.db
        .update(ticketCategories)
        .set(patch)
        .where(eq(ticketCategories.id, id))
        .returning();
      return row!;
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        throw new ConflictException("A category with that name already exists");
      }
      throw err;
    }
  }

  async delete(id: string) {
    await this.getById(id);
    // Assignments are cleared by the FK ON DELETE CASCADE.
    await this.db.delete(ticketCategories).where(eq(ticketCategories.id, id));
    return { ok: true };
  }

  async forTicket(ticketId: string) {
    return this.db
      .select({
        id: ticketCategories.id,
        name: ticketCategories.name,
        color: ticketCategories.color,
        createdAt: ticketCategories.createdAt,
      })
      .from(ticketCategoryAssignments)
      .innerJoin(
        ticketCategories,
        eq(ticketCategories.id, ticketCategoryAssignments.categoryId),
      )
      .where(eq(ticketCategoryAssignments.ticketId, ticketId))
      .orderBy(asc(ticketCategories.name));
  }

  /**
   * Replace the full category set for a ticket. Validates that every incoming
   * id resolves to a real row so a typo can't silently drop everything.
   */
  async setForTicket(ticketId: string, categoryIds: string[]) {
    if (categoryIds.length > 0) {
      const found = await this.db
        .select({ id: ticketCategories.id })
        .from(ticketCategories)
        .where(inArray(ticketCategories.id, categoryIds));
      const missing = categoryIds.filter((c) => !found.find((f) => f.id === c));
      if (missing.length) {
        throw new NotFoundException(`Category(ies) not found: ${missing.join(", ")}`);
      }
    }
    await this.db
      .delete(ticketCategoryAssignments)
      .where(eq(ticketCategoryAssignments.ticketId, ticketId));
    if (categoryIds.length > 0) {
      await this.db
        .insert(ticketCategoryAssignments)
        .values(categoryIds.map((categoryId) => ({ ticketId, categoryId })));
    }
    return this.forTicket(ticketId);
  }

  /** Bulk loader for list pages — keeps category chips off the N+1 path. */
  async categoriesForTickets(ticketIds: string[]) {
    if (ticketIds.length === 0)
      return new Map<string, { id: string; name: string; color: string }[]>();
    const rows = await this.db
      .select({
        ticketId: ticketCategoryAssignments.ticketId,
        id: ticketCategories.id,
        name: ticketCategories.name,
        color: ticketCategories.color,
      })
      .from(ticketCategoryAssignments)
      .innerJoin(
        ticketCategories,
        eq(ticketCategories.id, ticketCategoryAssignments.categoryId),
      )
      .where(inArray(ticketCategoryAssignments.ticketId, ticketIds));
    const map = new Map<string, { id: string; name: string; color: string }[]>();
    for (const r of rows) {
      const list = map.get(r.ticketId) ?? [];
      list.push({ id: r.id, name: r.name, color: r.color });
      map.set(r.ticketId, list);
    }
    return map;
  }
}

