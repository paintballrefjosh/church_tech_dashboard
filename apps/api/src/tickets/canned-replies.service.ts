import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import type { CreateCannedReplyInput, UpdateCannedReplyInput } from "@church/shared";
import { DB, type Db } from "../db/db.module";
import { ticketCannedReplies } from "../db/schema";

@Injectable()
export class CannedRepliesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  list() {
    return this.db.select().from(ticketCannedReplies).orderBy(asc(ticketCannedReplies.title));
  }

  async create(userId: string, input: CreateCannedReplyInput) {
    const [row] = await this.db
      .insert(ticketCannedReplies)
      .values({ title: input.title, body: input.body, createdByUserId: userId })
      .returning();
    if (!row) throw new Error("Insert failed");
    return row;
  }

  async update(id: string, input: UpdateCannedReplyInput) {
    const patch: Partial<typeof ticketCannedReplies.$inferInsert> = { updatedAt: new Date() };
    if (input.title !== undefined) patch.title = input.title;
    if (input.body !== undefined) patch.body = input.body;
    const [row] = await this.db.update(ticketCannedReplies).set(patch).where(eq(ticketCannedReplies.id, id)).returning();
    if (!row) throw new NotFoundException("Canned reply not found");
    return row;
  }

  async remove(id: string) {
    const [row] = await this.db.delete(ticketCannedReplies).where(eq(ticketCannedReplies.id, id)).returning();
    if (!row) throw new NotFoundException("Canned reply not found");
    return row;
  }
}
