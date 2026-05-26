import { Controller, Get, Post, Patch, Delete, Param, Body, BadRequestException } from "@nestjs/common";
import { PERMISSIONS, createRoleSchema, updateRoleSchema } from "@church/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { Audited } from "../audit/audit.decorator";
import { RolesService } from "./roles.service";

@Controller("roles")
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ROLES_READ_ANY)
  list() {
    return this.roles.list();
  }

  @Get("permissions")
  @RequirePermissions(PERMISSIONS.PERMISSIONS_READ_ANY)
  listPermissions() {
    return this.roles.listPermissions();
  }

  @Get(":id")
  @RequirePermissions(PERMISSIONS.ROLES_READ_ANY)
  byId(@Param("id") id: string) {
    return this.roles.getById(id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.ROLES_WRITE_ANY)
  @Audited({ action: "role.create", resourceType: "role" })
  create(@Body() body: unknown) {
    const parsed = createRoleSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.roles.create(parsed.data);
  }

  @Patch(":id")
  @RequirePermissions(PERMISSIONS.ROLES_WRITE_ANY)
  @Audited({ action: "role.update", resourceType: "role", resourceIdFromParams: (p) => p.id ?? null })
  update(@Param("id") id: string, @Body() body: unknown) {
    const parsed = updateRoleSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.roles.update(id, parsed.data);
  }

  @Delete(":id")
  @RequirePermissions(PERMISSIONS.ROLES_WRITE_ANY)
  @Audited({ action: "role.delete", resourceType: "role", resourceIdFromParams: (p) => p.id ?? null })
  remove(@Param("id") id: string) {
    return this.roles.delete(id);
  }
}
