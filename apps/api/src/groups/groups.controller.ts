import { Controller, Get, Post, Put, Patch, Delete, Param, Body, BadRequestException, Logger } from "@nestjs/common";
import { z } from "zod";
import { PERMISSIONS, createGroupSchema, updateGroupSchema, MODULE_TIERS } from "@church/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { Audited } from "../audit/audit.decorator";
import { GroupsService } from "./groups.service";

const memberBody = z.object({ userId: z.string().uuid() });

/**
 * { moduleKey -> tier | null }. null clears access; missing keys are left
 * unchanged is NOT supported — this is full-replace semantics so the UI can
 * just send the entire intended map on every save.
 */
const setModuleAccessBody = z.object({
  access: z.record(z.union([z.enum(MODULE_TIERS), z.null()])),
});

@Controller("groups")
export class GroupsController {
  private readonly logger = new Logger(GroupsController.name);
  constructor(private readonly groups: GroupsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.GROUPS_READ_ANY)
  list() {
    return this.groups.list();
  }

  @Get("matrix")
  @RequirePermissions(PERMISSIONS.PERMISSIONS_READ_ANY)
  matrix() {
    return this.groups.matrix();
  }

  @Get(":id")
  @RequirePermissions(PERMISSIONS.GROUPS_READ_ANY)
  byId(@Param("id") id: string) {
    return this.groups.getById(id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.USER_ADMIN)
  @Audited({ action: "group.create", resourceType: "group" })
  create(@Body() body: unknown) {
    const parsed = createGroupSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.groups.create(parsed.data);
  }

  @Patch(":id")
  @RequirePermissions(PERMISSIONS.USER_ADMIN)
  @Audited({ action: "group.update", resourceType: "group", resourceIdFromParams: (p) => p.id ?? null })
  update(@Param("id") id: string, @Body() body: unknown) {
    const parsed = updateGroupSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.groups.update(id, parsed.data);
  }

  @Delete(":id")
  @RequirePermissions(PERMISSIONS.USER_ADMIN)
  @Audited({ action: "group.delete", resourceType: "group", resourceIdFromParams: (p) => p.id ?? null })
  remove(@Param("id") id: string) {
    return this.groups.delete(id);
  }

  @Get(":id/members")
  @RequirePermissions(PERMISSIONS.GROUPS_READ_ANY)
  members(@Param("id") id: string) {
    return this.groups.members(id);
  }

  @Post(":id/members")
  @RequirePermissions(PERMISSIONS.USER_ADMIN)
  @Audited({ action: "group.addMember", resourceType: "group", resourceIdFromParams: (p) => p.id ?? null })
  addMember(@Param("id") id: string, @Body() body: unknown) {
    const { userId } = memberBody.parse(body);
    return this.groups.addMember(id, userId);
  }

  @Delete(":id/members/:userId")
  @RequirePermissions(PERMISSIONS.USER_ADMIN)
  @Audited({ action: "group.removeMember", resourceType: "group", resourceIdFromParams: (p) => p.id ?? null })
  removeMember(@Param("id") id: string, @Param("userId") userId: string) {
    return this.groups.removeMember(id, userId);
  }

  // ---- module access ----

  @Get(":id/module-access")
  @RequirePermissions(PERMISSIONS.GROUPS_READ_ANY)
  getModuleAccess(@Param("id") id: string) {
    return this.groups.getModuleAccess(id);
  }

  @Put(":id/module-access")
  @RequirePermissions(PERMISSIONS.USER_ADMIN)
  @Audited({ action: "group.setModuleAccess", resourceType: "group", resourceIdFromParams: (p) => p.id ?? null })
  setModuleAccess(@Param("id") id: string, @Body() body: unknown) {
    const parsed = setModuleAccessBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.groups.setModuleAccess(id, parsed.data.access);
  }

  /**
   * Read-only fallback used by anything still listing flat permission strings
   * (currently nothing; kept until we're sure). Derived from module access.
   */
  @Get(":id/permissions")
  @RequirePermissions(PERMISSIONS.GROUPS_READ_ANY)
  groupPermissions(@Param("id") id: string) {
    return this.groups.listPermissions(id);
  }

  @Post("sync-google")
  @RequirePermissions(PERMISSIONS.USER_ADMIN)
  @Audited({ action: "group.sync.google", resourceType: "group" })
  syncGoogle() {
    this.logger.warn("Google Groups sync requested but adapter is not implemented yet (Phase 0 stub).");
    return { ok: false, reason: "not-implemented", phase: 0 };
  }
}
