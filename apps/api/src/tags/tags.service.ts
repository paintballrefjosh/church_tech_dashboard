import { Injectable, Inject, NotFoundException, ConflictException } from "@nestjs/common";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { tags, tagAssignments } from "../db/schema";
import type { CreateTagInput, TaggableResourceType, UpdateTagInput } from "@church/shared";

@Injectable()
export class TagsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  list() {
    return this.db.select().from(tags).orderBy(asc(tags.name));
  }

  async getById(id: string) {
    const [row] = await this.db.select().from(tags).where(eq(tags.id, id)).limit(1);
    if (!row) throw new NotFoundException("Tag not found");
    return row;
  }

  async create(input: CreateTagInput) {
    try {
      const [row] = await this.db
        .insert(tags)
        .values({ name: input.name.trim(), color: input.color })
        .returning();
      if (!row) throw new Error("Insert failed");
      return row;
    } catch (err) {
      // Postgres unique-violation code → friendlier 409 for the UI.
      if ((err as { code?: string }).code === "23505") {
        throw new ConflictException("A tag with that name already exists");
      }
      throw err;
    }
  }

  async update(id: string, input: UpdateTagInput) {
    await this.getById(id);
    const patch: Partial<typeof tags.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.color !== undefined) patch.color = input.color;
    if (Object.keys(patch).length === 0) return this.getById(id);
    try {
      const [row] = await this.db.update(tags).set(patch).where(eq(tags.id, id)).returning();
      return row!;
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        throw new ConflictException("A tag with that name already exists");
      }
      throw err;
    }
  }

  async delete(id: string) {
    await this.getById(id);
    await this.db.delete(tags).where(eq(tags.id, id));
    return { ok: true };
  }

  /**
   * Tags currently assigned to a resource. We dedupe in-DB via the primary
   * key, but the join preserves duplicates only if the same tag is on two
   * resources — not the case for a single resource fetch.
   */
  async forResource(resourceType: TaggableResourceType, resourceId: string) {
    return this.db
      .select({
        id: tags.id,
        name: tags.name,
        color: tags.color,
        createdAt: tags.createdAt,
      })
      .from(tagAssignments)
      .innerJoin(tags, eq(tags.id, tagAssignments.tagId))
      .where(
        and(
          eq(tagAssignments.resourceType, resourceType),
          eq(tagAssignments.resourceId, resourceId),
        ),
      )
      .orderBy(asc(tags.name));
  }

  /**
   * Replace the full tag set on a resource. Verifies all incoming tagIds
   * exist so a typo doesn't silently drop assignments.
   */
  async setResourceTags(
    resourceType: TaggableResourceType,
    resourceId: string,
    tagIds: string[],
  ) {
    if (tagIds.length > 0) {
      const found = await this.db
        .select({ id: tags.id })
        .from(tags)
        .where(inArray(tags.id, tagIds));
      const missing = tagIds.filter((t) => !found.find((f) => f.id === t));
      if (missing.length) {
        throw new NotFoundException(`Tag(s) not found: ${missing.join(", ")}`);
      }
    }
    await this.db
      .delete(tagAssignments)
      .where(
        and(
          eq(tagAssignments.resourceType, resourceType),
          eq(tagAssignments.resourceId, resourceId),
        ),
      );
    if (tagIds.length > 0) {
      await this.db
        .insert(tagAssignments)
        .values(tagIds.map((tagId) => ({ tagId, resourceType, resourceId })));
    }
    return this.forResource(resourceType, resourceId);
  }

  /** Cascade helper — called from each resource's delete to drop dangling assignments. */
  async dropAssignmentsForResource(resourceType: TaggableResourceType, resourceId: string) {
    await this.db
      .delete(tagAssignments)
      .where(
        and(
          eq(tagAssignments.resourceType, resourceType),
          eq(tagAssignments.resourceId, resourceId),
        ),
      );
  }

  /**
   * Bulk fetch tag-ids for a list of resources — used by the resource list
   * endpoints so they can render tag chips without N+1 queries.
   */
  async tagsForResources(resourceType: TaggableResourceType, resourceIds: string[]) {
    if (resourceIds.length === 0) return new Map<string, { id: string; name: string; color: string }[]>();
    const rows = await this.db
      .select({
        resourceId: tagAssignments.resourceId,
        id: tags.id,
        name: tags.name,
        color: tags.color,
      })
      .from(tagAssignments)
      .innerJoin(tags, eq(tags.id, tagAssignments.tagId))
      .where(
        and(
          eq(tagAssignments.resourceType, resourceType),
          inArray(tagAssignments.resourceId, resourceIds),
        ),
      );
    const map = new Map<string, { id: string; name: string; color: string }[]>();
    for (const r of rows) {
      const list = map.get(r.resourceId) ?? [];
      list.push({ id: r.id, name: r.name, color: r.color });
      map.set(r.resourceId, list);
    }
    return map;
  }
}

// Drizzle quirk: keep `sql` referenced so esbuild doesn't tree-shake it if a
// future helper needs it.
void sql;
