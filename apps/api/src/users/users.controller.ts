import { Controller, Get, Post, Patch, Delete, Param, Body, BadRequestException } from "@nestjs/common";
import { z } from "zod";
import { PERMISSIONS, createLocalUserSchema, updateUserSchema } from "@church/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { Audited } from "../audit/audit.decorator";
import { UsersService } from "./users.service";

const createBody = createLocalUserSchema.extend({ roleKeys: z.array(z.string()).optional() });

@Controller("users")
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.USERS_READ_ANY)
  list() {
    return this.users.list();
  }

  @Get(":id")
  @RequirePermissions(PERMISSIONS.USERS_READ_ANY)
  byId(@Param("id") id: string) {
    return this.users.getById(id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.USERS_WRITE_ANY)
  @Audited({ action: "user.create", resourceType: "user" })
  async create(@Body() body: unknown) {
    const parsed = createBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.users.create({
      email: parsed.data.email,
      displayName: parsed.data.displayName,
      password: parsed.data.password,
      roleKeys: parsed.data.roleKeys,
    });
  }

  @Patch(":id")
  @RequirePermissions(PERMISSIONS.USERS_WRITE_ANY)
  @Audited({ action: "user.update", resourceType: "user", resourceIdFromParams: (p) => p.id ?? null })
  async update(@Param("id") id: string, @Body() body: unknown) {
    const parsed = updateUserSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.users.update(id, {
      displayName: parsed.data.displayName,
      isActive: parsed.data.isActive,
      image: parsed.data.avatarUrl ?? undefined,
    });
  }

  @Delete(":id")
  @RequirePermissions(PERMISSIONS.USERS_DELETE_ANY)
  @Audited({ action: "user.delete", resourceType: "user", resourceIdFromParams: (p) => p.id ?? null })
  async remove(@Param("id") id: string) {
    return this.users.delete(id);
  }
}
