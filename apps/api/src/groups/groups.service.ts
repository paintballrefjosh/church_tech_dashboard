import { Injectable, Inject, NotFoundException, ForbiddenException, BadRequestException } from "@nestjs/common";
import { eq, asc, and, isNull } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { groups, groupMemberships, groupModuleAccess, users } from "../db/schema";
import { AuthService } from "../auth/auth.service";
import {
  MODULES,
  findModule,
  permissionsFor,
  type ModuleTier,
} from "@church/shared";

const ADMIN_GROUP_NAME = "admin";

@Injectable()
export class GroupsService {
  constructor(@Inject(DB) private readonly db: Db, private readonly auth: AuthService) {}

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
    const existing = await this.getById(id);
    if (existing.name === ADMIN_GROUP_NAME) {
      throw new ForbiddenException("The admin group is locked and cannot be edited.");
    }
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
    // A rename changes what every member sees as their group list — coarse
    // invalidate is cheaper than scanning the membership table for ids.
    if (input.name !== undefined) this.auth.invalidateAllUsers();
    return row;
  }

  async delete(id: string) {
    const existing = await this.getById(id);
    if (existing.isSystem) {
      throw new ForbiddenException(`The ${existing.name} group is a system group and cannot be deleted.`);
    }
    const [row] = await this.db.delete(groups).where(eq(groups.id, id)).returning();
    if (!row) throw new NotFoundException("Group not found");
    this.auth.invalidateAllUsers();
    return row;
  }

  async members(groupId: string) {
    return this.db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(groupMemberships)
      .innerJoin(users, eq(users.id, groupMemberships.userId))
      .where(and(eq(groupMemberships.groupId, groupId), isNull(users.deletedAt)));
  }

  async addMember(groupId: string, userId: string) {
    await this.db
      .insert(groupMemberships)
      .values({ groupId, userId })
      .onConflictDoNothing();
    this.auth.invalidateUser(userId);
    return { ok: true };
  }

  async removeMember(groupId: string, userId: string) {
    await this.db
      .delete(groupMemberships)
      .where(and(eq(groupMemberships.groupId, groupId), eq(groupMemberships.userId, userId)));
    this.auth.invalidateUser(userId);
    return { ok: true };
  }

  /**
   * Module access map for a group: { moduleKey -> tier }. Modules the group
   * has no row for are simply absent (i.e. no access).
   */
  async getModuleAccess(groupId: string): Promise<Record<string, ModuleTier>> {
    await this.getById(groupId);
    const rows = await this.db
      .select({ moduleKey: groupModuleAccess.moduleKey, tier: groupModuleAccess.tier })
      .from(groupModuleAccess)
      .where(eq(groupModuleAccess.groupId, groupId));
    const out: Record<string, ModuleTier> = {};
    for (const r of rows) out[r.moduleKey] = r.tier as ModuleTier;
    return out;
  }

  /**
   * Full-replace semantics. Each key in `access` is a moduleKey; the value
   * is the tier ("user" | "moderator" | "admin") OR null to remove access.
   * Rejects unknown modules and tiers that the module doesn't expose.
   */
  async setModuleAccess(
    groupId: string,
    access: Record<string, ModuleTier | null>,
  ): Promise<{ ok: true }> {
    const grp = await this.getById(groupId);
    if (grp.name === ADMIN_GROUP_NAME) {
      throw new ForbiddenException("The admin group always has admin access on every module.");
    }
    const insertable: { moduleKey: string; tier: ModuleTier }[] = [];
    for (const [moduleKey, tier] of Object.entries(access)) {
      if (tier === null) continue;
      const def = findModule(moduleKey);
      if (!def) throw new BadRequestException(`unknown module: ${moduleKey}`);
      if (!def.tiers.includes(tier)) {
        throw new BadRequestException(
          `tier ${tier} not offered by module ${moduleKey} (offers: ${def.tiers.join("/")})`,
        );
      }
      insertable.push({ moduleKey, tier });
    }
    await this.db.delete(groupModuleAccess).where(eq(groupModuleAccess.groupId, groupId));
    if (insertable.length) {
      await this.db
        .insert(groupModuleAccess)
        .values(insertable.map((r) => ({ groupId, moduleKey: r.moduleKey, tier: r.tier })));
    }
    // Every member of this group now resolves to a different permission set.
    this.auth.invalidateAllUsers();
    return { ok: true };
  }

  /**
   * Compact representation used by the /admin/permissions matrix: every
   * group's module-access map alongside the catalog of modules + tiers, so
   * the UI can render rows × columns in a single render pass.
   */
  async matrix() {
    const [groupRows, accessRows] = await Promise.all([
      this.db.select().from(groups).orderBy(asc(groups.name)),
      this.db
        .select({
          groupId: groupModuleAccess.groupId,
          moduleKey: groupModuleAccess.moduleKey,
          tier: groupModuleAccess.tier,
        })
        .from(groupModuleAccess),
    ]);
    const accessByGroup = new Map<string, Record<string, ModuleTier>>();
    for (const r of accessRows) {
      const cur = accessByGroup.get(r.groupId) ?? {};
      cur[r.moduleKey] = r.tier as ModuleTier;
      accessByGroup.set(r.groupId, cur);
    }
    return {
      modules: MODULES.map((m) => ({
        key: m.key,
        label: m.label,
        description: m.description,
        tiers: m.tiers,
      })),
      groups: groupRows.map((g) => ({
        id: g.id,
        name: g.name,
        description: g.description,
        isSystem: g.isSystem,
        // For the admin group, the matrix shows admin on every module
        // regardless of what's in group_module_access (auth resolver does
        // the same short-circuit).
        access:
          g.name === ADMIN_GROUP_NAME
            ? Object.fromEntries(MODULES.map((m) => [m.key, m.tiers[m.tiers.length - 1]]))
            : (accessByGroup.get(g.id) ?? {}),
      })),
    };
  }

  // ---- legacy permission helpers (kept until the matrix UI migrates) ----

  /**
   * Returns the flat permission strings a group grants — derived from its
   * (module, tier) assignments via the shared catalog. Used by older UIs
   * that haven't been ported to the module model yet.
   */
  async listPermissions(groupId: string): Promise<string[]> {
    const access = await this.getModuleAccess(groupId);
    const grp = await this.getById(groupId);
    if (grp.name === ADMIN_GROUP_NAME) {
      // Mirror the auth-side short-circuit.
      const { ALL_PERMISSIONS } = await import("@church/shared");
      return [...ALL_PERMISSIONS];
    }
    const set = new Set<string>();
    for (const [moduleKey, tier] of Object.entries(access)) {
      for (const p of permissionsFor(moduleKey, tier)) set.add(p);
    }
    return [...set];
  }

  // Vestigial: kept for any caller that still tries to write permission
  // strings directly. Throws so we notice if anything still relies on it.
  async setPermissions(_groupId: string, _permissionKeys: string[]): Promise<{ ok: true }> {
    throw new BadRequestException(
      "Permission strings are no longer set directly — use PUT /groups/:id/module-access instead.",
    );
  }
}
