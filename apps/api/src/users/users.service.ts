import { Injectable, Inject, NotFoundException, ConflictException } from "@nestjs/common";
import { eq, asc } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { users, credentials, userRoles, roles as rolesTable } from "../db/schema";
import { AuthService } from "../auth/auth.service";

@Injectable()
export class UsersService {
  constructor(@Inject(DB) private readonly db: Db, private readonly auth: AuthService) {}

  async list() {
    const rows = await this.db.select().from(users).orderBy(asc(users.email));
    return rows;
  }

  async getById(id: string) {
    const [row] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!row) throw new NotFoundException("User not found");
    return row;
  }

  async create(input: { email: string; displayName: string; password?: string; roleKeys?: string[] }) {
    const [existing] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, input.email))
      .limit(1);
    if (existing) throw new ConflictException("Email already in use");

    const [user] = await this.db
      .insert(users)
      .values({ email: input.email, name: input.displayName, isActive: true })
      .returning();
    if (!user) throw new Error("Insert failed");

    if (input.password) {
      const hash = await this.auth.hashPassword(input.password);
      await this.db.insert(credentials).values({ userId: user.id, passwordHash: hash });
    }

    if (input.roleKeys?.length) {
      const roleRows = await this.db
        .select()
        .from(rolesTable)
        .where(eq(rolesTable.key, input.roleKeys[0]!)); // simplified for Phase 0
      if (roleRows.length) {
        await this.db.insert(userRoles).values(roleRows.map((r) => ({ userId: user.id, roleId: r.id })));
      }
    }

    return user;
  }

  async update(id: string, input: { displayName?: string; isActive?: boolean; image?: string | null }) {
    const [row] = await this.db
      .update(users)
      .set({
        ...(input.displayName !== undefined ? { name: input.displayName } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.image !== undefined ? { image: input.image } : {}),
        updatedAt: new Date(),
      })
      .where(eq(users.id, id))
      .returning();
    if (!row) throw new NotFoundException("User not found");
    return row;
  }

  async delete(id: string) {
    const [row] = await this.db.delete(users).where(eq(users.id, id)).returning();
    if (!row) throw new NotFoundException("User not found");
    return row;
  }
}
