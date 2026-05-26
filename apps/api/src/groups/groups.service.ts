import { Injectable, Inject, NotFoundException } from "@nestjs/common";
import { eq, asc, and } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { groups, groupMemberships, users } from "../db/schema";

@Injectable()
export class GroupsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  list() {
    return this.db.select().from(groups).orderBy(asc(groups.name));
  }

  async getById(id: string) {
    const [row] = await this.db.select().from(groups).where(eq(groups.id, id)).limit(1);
    if (!row) throw new NotFoundException("Group not found");
    return row;
  }

  async create(input: { name: string; description?: string | null }) {
    const [row] = await this.db
      .insert(groups)
      .values({ name: input.name, description: input.description ?? null, isManaged: false })
      .returning();
    if (!row) throw new Error("Insert failed");
    return row;
  }

  async update(id: string, input: { name?: string; description?: string | null }) {
    const [row] = await this.db
      .update(groups)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        updatedAt: new Date(),
      })
      .where(eq(groups.id, id))
      .returning();
    if (!row) throw new NotFoundException("Group not found");
    return row;
  }

  async delete(id: string) {
    const [row] = await this.db.delete(groups).where(eq(groups.id, id)).returning();
    if (!row) throw new NotFoundException("Group not found");
    return row;
  }

  async members(groupId: string) {
    return this.db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(groupMemberships)
      .innerJoin(users, eq(users.id, groupMemberships.userId))
      .where(eq(groupMemberships.groupId, groupId));
  }

  async addMember(groupId: string, userId: string) {
    await this.db
      .insert(groupMemberships)
      .values({ groupId, userId })
      .onConflictDoNothing();
    return { ok: true };
  }

  async removeMember(groupId: string, userId: string) {
    await this.db
      .delete(groupMemberships)
      .where(and(eq(groupMemberships.groupId, groupId), eq(groupMemberships.userId, userId)));
    return { ok: true };
  }
}
