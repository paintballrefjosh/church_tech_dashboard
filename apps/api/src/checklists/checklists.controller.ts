import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  BadRequestException,
} from "@nestjs/common";
import {
  PERMISSIONS,
  createTemplateSchema,
  updateTemplateSchema,
  createTemplateTaskSchema,
  updateTemplateTaskSchema,
  createEventSchema,
  updateEventSchema,
  updateEventTaskSchema,
  addAssigneeSchema,
  applyPlanSchema,
  createServiceSchema,
  updateServiceSchema,
  createStationSchema,
  updateStationSchema,
} from "@church/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { Audited } from "../audit/audit.decorator";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { ChecklistsService } from "./checklists.service";

@Controller("checklists")
export class ChecklistsController {
  constructor(private readonly checklists: ChecklistsService) {}

  // ---- Stations ----

  @Get("stations")
  @RequirePermissions(PERMISSIONS.CHECKLISTS_READ_ANY)
  listStations() {
    return this.checklists.listStations();
  }

  @Post("stations")
  @RequirePermissions(PERMISSIONS.CHECKLISTS_ADMIN)
  @Audited({ action: "checklist.station.create", resourceType: "checklist_station" })
  async createStation(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const parsed = createStationSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.checklists.createStation(user, parsed.data);
  }

  @Patch("stations/:id")
  @RequirePermissions(PERMISSIONS.CHECKLISTS_ADMIN)
  @Audited({
    action: "checklist.station.update",
    resourceType: "checklist_station",
    resourceIdFromParams: (p) => p.id ?? null,
  })
  async updateStation(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const parsed = updateStationSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.checklists.updateStation(user, id, parsed.data);
  }

  @Delete("stations/:id")
  @RequirePermissions(PERMISSIONS.CHECKLISTS_ADMIN)
  @Audited({
    action: "checklist.station.delete",
    resourceType: "checklist_station",
    resourceIdFromParams: (p) => p.id ?? null,
  })
  deleteStation(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.checklists.deleteStation(user, id);
  }

  // ---- Templates ----

  @Get("templates")
  @RequirePermissions(PERMISSIONS.CHECKLISTS_READ_ANY)
  listTemplates() {
    return this.checklists.listTemplates();
  }

  @Get("templates/:id")
  @RequirePermissions(PERMISSIONS.CHECKLISTS_READ_ANY)
  async template(@Param("id") id: string) {
    const template = await this.checklists.getTemplate(id);
    const tasks = await this.checklists.templateTasks(id);
    return { template, tasks };
  }

  @Post("templates")
  @RequirePermissions(PERMISSIONS.CHECKLISTS_ADMIN)
  @Audited({ action: "checklist.template.create", resourceType: "checklist_template" })
  async createTemplate(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const parsed = createTemplateSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.checklists.createTemplate(user, parsed.data);
  }

  @Patch("templates/:id")
  @RequirePermissions(PERMISSIONS.CHECKLISTS_ADMIN)
  @Audited({
    action: "checklist.template.update",
    resourceType: "checklist_template",
    resourceIdFromParams: (p) => p.id ?? null,
  })
  async updateTemplate(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const parsed = updateTemplateSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.checklists.updateTemplate(user, id, parsed.data);
  }

  @Delete("templates/:id")
  @RequirePermissions(PERMISSIONS.CHECKLISTS_ADMIN)
  @Audited({
    action: "checklist.template.delete",
    resourceType: "checklist_template",
    resourceIdFromParams: (p) => p.id ?? null,
  })
  deleteTemplate(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.checklists.deleteTemplate(user, id);
  }

  @Post("templates/:id/tasks")
  @RequirePermissions(PERMISSIONS.CHECKLISTS_ADMIN)
  @Audited({
    action: "checklist.template.task.create",
    resourceType: "checklist_template",
    resourceIdFromParams: (p) => p.id ?? null,
  })
  async addTemplateTask(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") templateId: string,
    @Body() body: unknown,
  ) {
    const parsed = createTemplateTaskSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.checklists.addTemplateTask(user, templateId, parsed.data);
  }

  @Patch("template-tasks/:taskId")
  @RequirePermissions(PERMISSIONS.CHECKLISTS_ADMIN)
  @Audited({
    action: "checklist.template.task.update",
    resourceType: "checklist_template_task",
    resourceIdFromParams: (p) => p.taskId ?? null,
  })
  async updateTemplateTask(
    @CurrentUser() user: AuthenticatedUser,
    @Param("taskId") taskId: string,
    @Body() body: unknown,
  ) {
    const parsed = updateTemplateTaskSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.checklists.updateTemplateTask(user, taskId, parsed.data);
  }

  @Delete("template-tasks/:taskId")
  @RequirePermissions(PERMISSIONS.CHECKLISTS_ADMIN)
  @Audited({
    action: "checklist.template.task.delete",
    resourceType: "checklist_template_task",
    resourceIdFromParams: (p) => p.taskId ?? null,
  })
  deleteTemplateTask(@CurrentUser() user: AuthenticatedUser, @Param("taskId") taskId: string) {
    return this.checklists.deleteTemplateTask(user, taskId);
  }

  // ---- Events ----

  @Get("events")
  @RequirePermissions(PERMISSIONS.CHECKLISTS_READ_ASSIGNED)
  listEvents(
    @CurrentUser() user: AuthenticatedUser,
    @Query("upcoming") upcoming?: string,
  ) {
    return this.checklists.listEvents(user, { upcomingOnly: upcoming === "true" });
  }

  @Get("events/:id")
  @RequirePermissions(PERMISSIONS.CHECKLISTS_READ_ASSIGNED)
  event(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.checklists.getEvent(user, id);
  }

  @Post("events")
  @RequirePermissions(PERMISSIONS.CHECKLISTS_ADMIN)
  @Audited({ action: "checklist.event.create", resourceType: "checklist_event" })
  async createEvent(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const parsed = createEventSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.checklists.createEvent(user, parsed.data);
  }

  @Patch("events/:id")
  @RequirePermissions(PERMISSIONS.CHECKLISTS_ADMIN)
  @Audited({
    action: "checklist.event.update",
    resourceType: "checklist_event",
    resourceIdFromParams: (p) => p.id ?? null,
  })
  async updateEvent(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const parsed = updateEventSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.checklists.updateEvent(user, id, parsed.data);
  }

  @Delete("events/:id")
  @RequirePermissions(PERMISSIONS.CHECKLISTS_ADMIN)
  @Audited({
    action: "checklist.event.delete",
    resourceType: "checklist_event",
    resourceIdFromParams: (p) => p.id ?? null,
  })
  deleteEvent(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.checklists.deleteEvent(user, id);
  }

  // ---- Roster (station assignees) ----

  @Get("assignable-users")
  @RequirePermissions(PERMISSIONS.CHECKLISTS_ADMIN)
  assignableUsers(@CurrentUser() user: AuthenticatedUser) {
    return this.checklists.assignableUsers(user);
  }

  @Post("events/:id/assignees")
  @RequirePermissions(PERMISSIONS.CHECKLISTS_ADMIN)
  @Audited({
    action: "checklist.event.assignee.add",
    resourceType: "checklist_event",
    resourceIdFromParams: (p) => p.id ?? null,
  })
  async addAssignee(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const parsed = addAssigneeSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.checklists.addAssignee(user, id, parsed.data);
  }

  @Delete("events/:id/assignees/:assigneeId")
  @RequirePermissions(PERMISSIONS.CHECKLISTS_ADMIN)
  @Audited({
    action: "checklist.event.assignee.remove",
    resourceType: "checklist_event",
    resourceIdFromParams: (p) => p.id ?? null,
  })
  removeAssignee(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Param("assigneeId") assigneeId: string,
  ) {
    return this.checklists.removeAssignee(user, id, assigneeId);
  }

  // ---- Sync from Plan (per-position conflict diff) ----

  @Get("events/:id/plan-diff")
  @RequirePermissions(PERMISSIONS.CHECKLISTS_ADMIN)
  planDiff(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.checklists.planDiff(user, id);
  }

  @Post("events/:id/apply-plan")
  @RequirePermissions(PERMISSIONS.CHECKLISTS_ADMIN)
  @Audited({
    action: "checklist.event.apply_plan",
    resourceType: "checklist_event",
    resourceIdFromParams: (p) => p.id ?? null,
  })
  async applyPlan(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const parsed = applyPlanSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.checklists.applyPlan(user, id, parsed.data);
  }

  // ---- Recurring services ----

  @Get("services")
  @RequirePermissions(PERMISSIONS.CHECKLISTS_READ_ANY)
  listServices(@CurrentUser() user: AuthenticatedUser) {
    return this.checklists.listServices(user);
  }

  @Get("services/:id")
  @RequirePermissions(PERMISSIONS.CHECKLISTS_READ_ANY)
  service(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.checklists.getService(user, id);
  }

  @Get("templates/:id/positions")
  @RequirePermissions(PERMISSIONS.CHECKLISTS_READ_ANY)
  templatePositions(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.checklists.templatePositions(user, id);
  }

  /** Union of station names across several templates — used by the service
   * editor once more than one template is selected. `ids` is comma-separated. */
  @Get("template-positions")
  @RequirePermissions(PERMISSIONS.CHECKLISTS_READ_ANY)
  templatePositionsForMany(@CurrentUser() user: AuthenticatedUser, @Query("ids") ids?: string) {
    const templateIds = (ids ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return this.checklists.templatePositionsForMany(user, templateIds);
  }

  @Post("services")
  @RequirePermissions(PERMISSIONS.CHECKLISTS_ADMIN)
  @Audited({ action: "checklist.service.create", resourceType: "checklist_service" })
  async createService(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const parsed = createServiceSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.checklists.createService(user, parsed.data);
  }

  @Patch("services/:id")
  @RequirePermissions(PERMISSIONS.CHECKLISTS_ADMIN)
  @Audited({
    action: "checklist.service.update",
    resourceType: "checklist_service",
    resourceIdFromParams: (p) => p.id ?? null,
  })
  async updateService(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const parsed = updateServiceSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.checklists.updateService(user, id, parsed.data);
  }

  @Delete("services/:id")
  @RequirePermissions(PERMISSIONS.CHECKLISTS_ADMIN)
  @Audited({
    action: "checklist.service.delete",
    resourceType: "checklist_service",
    resourceIdFromParams: (p) => p.id ?? null,
  })
  deleteService(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Query("deleteFutureEvents") deleteFutureEvents?: string,
  ) {
    return this.checklists.deleteService(user, id, deleteFutureEvents === "true");
  }

  @Post("services/:id/generate")
  @RequirePermissions(PERMISSIONS.CHECKLISTS_ADMIN)
  @Audited({
    action: "checklist.service.generate",
    resourceType: "checklist_service",
    resourceIdFromParams: (p) => p.id ?? null,
  })
  generateService(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.checklists.generateService(user, id);
  }

  @Patch("event-tasks/:taskId")
  @RequirePermissions(PERMISSIONS.CHECKLISTS_READ_ASSIGNED)
  @Audited({
    action: "checklist.event.task.update",
    resourceType: "checklist_event_task",
    resourceIdFromParams: (p) => p.taskId ?? null,
  })
  async updateEventTask(
    @CurrentUser() user: AuthenticatedUser,
    @Param("taskId") taskId: string,
    @Body() body: unknown,
  ) {
    const parsed = updateEventTaskSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.checklists.updateEventTask(user, taskId, parsed.data);
  }

  // ---- Reports + dashboard ----

  @Get("my/open-tasks")
  @RequirePermissions(PERMISSIONS.CHECKLISTS_READ_ASSIGNED)
  myOpenTasks(@CurrentUser() user: AuthenticatedUser) {
    return this.checklists.myOpenTasks(user);
  }

  @Get("reports/events")
  @RequirePermissions(PERMISSIONS.CHECKLISTS_READ_ANY)
  eventStats(@Query("limit") limit?: string) {
    return this.checklists.eventStats(
      // Cast — controller's read:any guard handles auth; we just need a value
      // to pass through to the service for the inner perm-check.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { permissions: [PERMISSIONS.CHECKLISTS_READ_ANY] } as any,
      limit ? parseInt(limit, 10) : 50,
    );
  }

  @Get("reports/volunteers")
  @RequirePermissions(PERMISSIONS.CHECKLISTS_READ_ANY)
  volunteerStats(@Query("limit") limit?: string) {
    return this.checklists.volunteerStats(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { permissions: [PERMISSIONS.CHECKLISTS_READ_ANY] } as any,
      limit ? parseInt(limit, 10) : 100,
    );
  }
}
