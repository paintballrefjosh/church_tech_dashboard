import { Injectable, Inject, NotFoundException, ConflictException } from "@nestjs/common";
import { eq, asc, inArray } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { roles, permissions, rolePermissions } from "../db/schema";

@Injectable()
export class RolesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async list() {
    const all = await this.db.select().from(roles).orderBy(asc(roles.key));
    const allPerms = await this.db.select().from(rolePermissions);
    const byRole = new Map<string, string[]>();
    for (const rp of allPerms) {
      const list = byRole.get(rp.roleId) ?? [];
      list.push(rp.permissionKey);
      byRole.set(rp.roleId, list);
    }
    return all.map((r) => ({ ...r, permissions: byRole.get(r.id) ?? [] }));
  }

  async getById(id: string) {
    const [row] = await this.db.select().from(roles).where(eq(roles.id, id)).limit(1);
    if (!row) throw new NotFoundException("Role not found");
    const perms = await this.db
      .select({ key: rolePermissions.permissionKey })
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, id));
    return { ...row, permissions: perms.map((p) => p.key) };
  }

  async listPermissions() {
    return this.db.select().from(permissions).orderBy(asc(permissions.key));
  }

  async create(input: { key: string; description?: string | null; permissions?: string[] }) {
    const [existing] = await this.db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.key, input.key))
      .limit(1);
    if (existing) throw new ConflictException("Role key already exists");

    const [row] = await this.db
      .insert(roles)
      .values({ key: input.key, description: input.description ?? null, isSystem: false })
      .returning();
    if (!row) throw new Error("Insert failed");

    if (input.permissions?.length) {
      await this.setPermissions(row.id, input.permissions);
    }
    return this.getById(row.id);
  }

  async update(id: string, input: { description?: string | null; permissions?: string[] }) {
    const [row] = await this.db.select().from(roles).where(eq(roles.id, id)).limit(1);
    if (!row) throw new NotFoundException("Role not found");

    if (input.description !== undefined) {
      await this.db
        .update(roles)
        .set({ description: input.description, updatedAt: new Date() })
        .where(eq(roles.id, id));
    }
    if (input.permissions) {
      await this.setPermissions(id, input.permissions);
    }
    return this.getById(id);
  }

  async setPermissions(roleId: string, permKeys: string[]) {
    const validKeys = await this.db
      .select({ key: permissions.key })
      .from(permissions)
      .where(permKeys.length ? inArray(permissions.key, permKeys) : eq(permissions.key, ""));
    const valid = new Set(validKeys.map((p) => p.key));
    const desired = permKeys.filter((k) => valid.has(k));

    await this.db.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
    if (desired.length) {
      await this.db
        .insert(rolePermissions)
        .values(desired.map((permissionKey) => ({ roleId, permissionKey })));
    }
  }

  async delete(id: string) {
    const [row] = await this.db.select().from(roles).where(eq(roles.id, id)).limit(1);
    if (!row) throw new NotFoundException("Role not found");
    if (row.isSystem) throw new ConflictException("Cannot delete system role");
    await this.db.delete(roles).where(eq(roles.id, id));
    return { ok: true };
  }
}
