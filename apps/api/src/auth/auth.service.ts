import { Injectable, Inject } from "@nestjs/common";
import { eq, inArray } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import argon2 from "argon2";
import { DB, type Db } from "../db/db.module";
import {
  users,
  totpSecrets,
  userRoles,
  roles,
  rolePermissions,
  apiTokens,
} from "../db/schema";
import type { AuthenticatedUser } from "./current-user.decorator";

@Injectable()
export class AuthService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async hashPassword(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id });
  }

  async verifyPassword(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  generateToken(bytes = 32): string {
    return randomBytes(bytes).toString("base64url");
  }

  async findUserByApiToken(token: string): Promise<AuthenticatedUser | null> {
    const hash = this.hashToken(token);
    const [row] = await this.db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.tokenHash, hash))
      .limit(1);
    if (!row) return null;
    if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;
    await this.db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, row.id));
    return this.loadUserById(row.userId);
  }

  async loadUserById(userId: string): Promise<AuthenticatedUser | null> {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user || !user.isActive) return null;

    const userRoleRows = await this.db
      .select({ key: roles.key, roleId: roles.id })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(eq(userRoles.userId, userId));

    const roleKeys = userRoleRows.map((r) => r.key);
    const roleIds = userRoleRows.map((r) => r.roleId);

    let permissionRows: { permissionKey: string }[] = [];
    if (roleIds.length) {
      permissionRows = await this.db
        .selectDistinct({ permissionKey: rolePermissions.permissionKey })
        .from(rolePermissions)
        .where(inArray(rolePermissions.roleId, roleIds));
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      isActive: user.isActive,
      totpEnabled: user.totpEnabled,
      roles: roleKeys,
      permissions: permissionRows.map((p) => p.permissionKey),
    };
  }

  async getTotpSecret(userId: string): Promise<string | null> {
    const [row] = await this.db
      .select()
      .from(totpSecrets)
      .where(eq(totpSecrets.userId, userId))
      .limit(1);
    return row?.secret ?? null;
  }
}
