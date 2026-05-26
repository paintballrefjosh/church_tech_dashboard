import { Controller, Get, Post, Patch, Delete, Param, Body, BadRequestException, Logger } from "@nestjs/common";
import { z } from "zod";
import { PERMISSIONS, createGroupSchema, updateGroupSchema } from "@church/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { Audited } from "../audit/audit.decorator";
import { GroupsService } from "./groups.service";

const memberBody = z.object({ userId: z.string().uuid() });

@Controller("groups")
export class GroupsController {
  private readonly logger = new Logger(GroupsController.name);
  constructor(private readonly groups: GroupsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.GROUPS_READ_ANY)
  list() {
    return this.groups.list();
  }

  @Get(":id")
  @RequirePermissions(PERMISSIONS.GROUPS_READ_ANY)
  byId(@Param("id") id: string) {
    return this.groups.getById(id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.GROUPS_WRITE_ANY)
  @Audited({ action: "group.create", resourceType: "group" })
  create(@Body() body: unknown) {
    const parsed = createGroupSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.groups.create(parsed.data);
  }

  @Patch(":id")
  @RequirePermissions(PERMISSIONS.GROUPS_WRITE_ANY)
  @Audited({ action: "group.update", resourceType: "group", resourceIdFromParams: (p) => p.id ?? null })
  update(@Param("id") id: string, @Body() body: unknown) {
    const parsed = updateGroupSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.groups.update(id, parsed.data);
  }

  @Delete(":id")
  @RequirePermissions(PERMISSIONS.GROUPS_WRITE_ANY)
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
  @RequirePermissions(PERMISSIONS.GROUPS_WRITE_ANY)
  @Audited({ action: "group.addMember", resourceType: "group", resourceIdFromParams: (p) => p.id ?? null })
  addMember(@Param("id") id: string, @Body() body: unknown) {
    const { userId } = memberBody.parse(body);
    return this.groups.addMember(id, userId);
  }

  @Delete(":id/members/:userId")
  @RequirePermissions(PERMISSIONS.GROUPS_WRITE_ANY)
  @Audited({ action: "group.removeMember", resourceType: "group", resourceIdFromParams: (p) => p.id ?? null })
  removeMember(@Param("id") id: string, @Param("userId") userId: string) {
    return this.groups.removeMember(id, userId);
  }

  @Post("sync-google")
  @RequirePermissions(PERMISSIONS.GROUPS_SYNC_GOOGLE)
  @Audited({ action: "group.sync.google", resourceType: "group" })
  syncGoogle() {
    // Phase 0 stub. Google Admin SDK wiring lands when the church's service-account
    // JSON is provisioned (see INSTALL.md § "Google Workspace setup").
    this.logger.warn("Google Groups sync requested but adapter is not implemented yet (Phase 0 stub).");
    return { ok: false, reason: "not-implemented", phase: 0 };
  }
}
