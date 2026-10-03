import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  BadRequestException,
} from "@nestjs/common";
import { z } from "zod";
import { PERMISSIONS } from "@church/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { Audited } from "../audit/audit.decorator";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { PlanningCenterService } from "./planning-center.service";

const linkBody = z.object({ pcPersonId: z.string().min(1).max(64) });
const adminLinkBody = z.object({
  userId: z.string().uuid(),
  pcPersonId: z.string().min(1).max(64),
});

@Controller("planning-center")
export class PlanningCenterController {
  constructor(private readonly pc: PlanningCenterService) {}

  @Get("health")
  @RequirePermissions(PERMISSIONS.PLANNING_CENTER_READ_ANY)
  health() {
    return this.pc.health();
  }

  @Get("service-types")
  @RequirePermissions(PERMISSIONS.PLANNING_CENTER_READ_ANY)
  serviceTypes() {
    return this.pc.listServiceTypes();
  }

  @Get("plans")
  @RequirePermissions(PERMISSIONS.PLANNING_CENTER_READ_ANY)
  plans(
    @Query("service_type_id") serviceTypeId?: string,
    @Query("limit") limit?: string,
  ) {
    return this.pc.listUpcomingPlans({
      serviceTypeId: serviceTypeId || undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get("plans/:serviceTypeId/:planId")
  @RequirePermissions(PERMISSIONS.PLANNING_CENTER_READ_ANY)
  planDetail(
    @Param("serviceTypeId") serviceTypeId: string,
    @Param("planId") planId: string,
  ) {
    return this.pc.planDetail(serviceTypeId, planId);
  }

  @Get("people")
  @RequirePermissions(PERMISSIONS.PLANNING_CENTER_READ_ANY)
  people(@Query("q") q?: string, @Query("limit") limit?: string) {
    return this.pc.listPeople({
      q: q || undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  // ---- link management ----

  @Get("links")
  @RequirePermissions(PERMISSIONS.PLANNING_CENTER_ADMIN)
  links() {
    return this.pc.listLinks();
  }

  @Get("me/link")
  @RequirePermissions(PERMISSIONS.PLANNING_CENTER_READ_ANY)
  myLink(@CurrentUser() user: AuthenticatedUser) {
    return this.pc.myLink(user.id);
  }

  @Post("me/link")
  @RequirePermissions(PERMISSIONS.PLANNING_CENTER_READ_ANY)
  @Audited({ action: "planning_center.link.self", resourceType: "planning_center" })
  async linkSelf(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const parsed = linkBody.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.pc.link(user.id, parsed.data.pcPersonId);
  }

  @Delete("me/link")
  @RequirePermissions(PERMISSIONS.PLANNING_CENTER_READ_ANY)
  @Audited({ action: "planning_center.unlink.self", resourceType: "planning_center" })
  unlinkSelf(@CurrentUser() user: AuthenticatedUser) {
    return this.pc.unlinkUser(user.id);
  }

  @Post("links")
  @RequirePermissions(PERMISSIONS.PLANNING_CENTER_ADMIN)
  @Audited({ action: "planning_center.link.admin", resourceType: "planning_center" })
  async linkAdmin(@Body() body: unknown) {
    const parsed = adminLinkBody.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.pc.link(parsed.data.userId, parsed.data.pcPersonId);
  }

  @Delete("links/:userId")
  @RequirePermissions(PERMISSIONS.PLANNING_CENTER_ADMIN)
  @Audited({
    action: "planning_center.unlink.admin",
    resourceType: "planning_center",
    resourceIdFromParams: (p) => p.userId ?? null,
  })
  unlinkAdmin(@Param("userId") userId: string) {
    return this.pc.unlinkUser(userId);
  }
}
