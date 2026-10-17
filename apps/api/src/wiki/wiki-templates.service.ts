import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import type { CreateWikiTemplateInput, UpdateWikiTemplateInput } from "@church/shared";
import { DB, type Db } from "../db/db.module";
import { wikiTemplates } from "../db/schema";

/** Saved starting points for new pages. The built-in outlines are in code (`WIKI_STARTER_TEMPLATES`), not here. */
@Injectable()
export class WikiTemplatesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  list() {
    return this.db.select().from(wikiTemplates).orderBy(asc(wikiTemplates.name));
  }

  async create(userId: string, input: CreateWikiTemplateInput) {
    const [row] = await this.db
      .insert(wikiTemplates)
      .values({ name: input.name, description: input.description, body: input.body, createdByUserId: userId })
      .returning();
    if (!row) throw new Error("Insert failed");
    return row;
  }

  async update(id: string, input: UpdateWikiTemplateInput) {
    const patch: Partial<typeof wikiTemplates.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description;
    if (input.body !== undefined) patch.body = input.body;
    const [row] = await this.db.update(wikiTemplates).set(patch).where(eq(wikiTemplates.id, id)).returning();
    if (!row) throw new NotFoundException("Template not found");
    return row;
  }

  async remove(id: string) {
    const [row] = await this.db.delete(wikiTemplates).where(eq(wikiTemplates.id, id)).returning();
    if (!row) throw new NotFoundException("Template not found");
    return row;
  }
}
