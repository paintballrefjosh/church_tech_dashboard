import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query } from "@nestjs/common";
import { z } from "zod";
import {
  PERMISSIONS,
  serviceGroupSaveSchema,
  serviceInstanceCreateSchema,
  serviceInstanceUpdateSchema,
  serviceLoginSaveSchema,
  serviceTemplateKeySchema,
  serviceTemplateSaveSchema,
  serviceTestSchema,
} from "@church/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { OperationalOnly } from "../auth/operational-only.decorator";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { Audited } from "../audit/audit.decorator";
import { InfraCollector } from "../infra/infra-collector";
import { ServiceMonitoringService } from "./service-monitoring.service";
import { ServicePoller } from "./service-poller";
import { ServiceGroupsService } from "./service-groups.service";

function parse<T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { flatten: () => unknown } } }, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
  return parsed.data;
}

const forkSchema = z.object({ key: serviceTemplateKeySchema, confirmCommands: z.array(z.string()).optional() });

/**
 * Service monitoring (docs/service-monitoring.md). Reads gate on `monitors:read:any` like the rest of Monitoring; every
 * write, the logins and the Test run gate on `monitors:write:any` (a template can run commands on hosts). Anything that
 * reaches a live host (Test, Check now, suggestions from the host's units) is `@OperationalOnly` for API tokens.
 */
@Controller("service-monitoring")
export class ServiceMonitoringController {
  constructor(
    private readonly services: ServiceMonitoringService,
    private readonly poller: ServicePoller,
    private readonly collector: InfraCollector,
    private readonly groups: ServiceGroupsService,
  ) {}

  // ---- templates ----

  @Get("templates")
  @RequirePermissions(PERMISSIONS.MONITORS_READ_ANY)
  templates() {
    return this.services.templates();
  }

  @Get("templates/:key")
  @RequirePermissions(PERMISSIONS.MONITORS_READ_ANY)
  template(@Param("key") key: string) {
    return this.services.template(key);
  }

  @Put("templates/:key")
  @RequirePermissions(PERMISSIONS.MONITORS_WRITE_ANY)
  @Audited({ action: "service.template.save", resourceType: "service_template", resourceIdFromParams: (p) => p.key ?? null })
  saveTemplate(@Param("key") key: string, @Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    const input = parse(serviceTemplateSaveSchema, { ...(body as object), key });
    return this.services.saveTemplate(input.key, input.body, input.confirmCommands, user.id);
  }

  @Post("templates/:key/fork")
  @RequirePermissions(PERMISSIONS.MONITORS_WRITE_ANY)
  @Audited({ action: "service.template.fork", resourceType: "service_template", resourceIdFromParams: (p) => p.key ?? null })
  fork(@Param("key") key: string, @Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    const input = parse(forkSchema, body);
    return this.services.forkTemplate(key, input.key, user.id, input.confirmCommands);
  }

  @Delete("templates/:key")
  @RequirePermissions(PERMISSIONS.MONITORS_WRITE_ANY)
  @Audited({ action: "service.template.delete", resourceType: "service_template", resourceIdFromParams: (p) => p.key ?? null })
  deleteTemplate(@Param("key") key: string) {
    return this.services.deleteTemplate(key);
  }

  // ---- logins (user names are shown only to the people who may write) ----

  @Get("logins")
  @RequirePermissions(PERMISSIONS.MONITORS_WRITE_ANY)
  logins() {
    return this.services.logins();
  }

  @Post("logins")
  @RequirePermissions(PERMISSIONS.MONITORS_WRITE_ANY)
  @Audited({ action: "service.login.create", resourceType: "service_login", redactKeys: ["password"] })
  createLogin(@Body() body: unknown) {
    return this.services.createLogin(parse(serviceLoginSaveSchema, body));
  }

  @Patch("logins/:id")
  @RequirePermissions(PERMISSIONS.MONITORS_WRITE_ANY)
  @Audited({ action: "service.login.update", resourceType: "service_login", resourceIdFromParams: (p) => p.id ?? null, redactKeys: ["password"] })
  updateLogin(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.services.updateLogin(id, parse(serviceLoginSaveSchema, body));
  }

  @Delete("logins/:id")
  @RequirePermissions(PERMISSIONS.MONITORS_WRITE_ANY)
  @Audited({ action: "service.login.delete", resourceType: "service_login", resourceIdFromParams: (p) => p.id ?? null })
  deleteLogin(@Param("id", ParseUUIDPipe) id: string) {
    return this.services.deleteLogin(id);
  }

  // ---- groups (services on different hosts judged together) ----

  @Get("groups")
  @RequirePermissions(PERMISSIONS.MONITORS_READ_ANY)
  listGroups() {
    return this.groups.list();
  }

  /** The state metrics the given services share: what a group of them could count as its role. */
  @Get("groups/role-choices")
  @RequirePermissions(PERMISSIONS.MONITORS_READ_ANY)
  roleChoices(@Query("ids") ids?: string) {
    const list = (ids ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (list.length > 100 || list.some((x) => !z.string().uuid().safeParse(x).success)) throw new BadRequestException("ids is a comma list of service ids");
    return this.groups.roleChoices(list);
  }

  @Get("groups/:id")
  @RequirePermissions(PERMISSIONS.MONITORS_READ_ANY)
  getGroup(@Param("id", ParseUUIDPipe) id: string) {
    return this.groups.get(id);
  }

  @Get("groups/:id/incidents")
  @RequirePermissions(PERMISSIONS.MONITORS_READ_ANY)
  groupIncidents(@Param("id", ParseUUIDPipe) id: string) {
    return this.groups.incidents(id);
  }

  @Post("groups")
  @RequirePermissions(PERMISSIONS.MONITORS_WRITE_ANY)
  @Audited({ action: "service.group.create", resourceType: "service_group" })
  createGroup(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.groups.create(parse(serviceGroupSaveSchema, body), user.id);
  }

  @Put("groups/:id")
  @RequirePermissions(PERMISSIONS.MONITORS_WRITE_ANY)
  @Audited({ action: "service.group.update", resourceType: "service_group", resourceIdFromParams: (p) => p.id ?? null })
  updateGroup(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.groups.update(id, parse(serviceGroupSaveSchema, body));
  }

  @Delete("groups/:id")
  @RequirePermissions(PERMISSIONS.MONITORS_WRITE_ANY)
  @Audited({ action: "service.group.delete", resourceType: "service_group", resourceIdFromParams: (p) => p.id ?? null })
  deleteGroup(@Param("id", ParseUUIDPipe) id: string) {
    return this.groups.remove(id);
  }

  // ---- instances ----

  @Get("instances")
  @RequirePermissions(PERMISSIONS.MONITORS_READ_ANY)
  list(@Query("targetId") targetId?: string) {
    if (targetId !== undefined && !z.string().uuid().safeParse(targetId).success) throw new BadRequestException("targetId is not an id");
    return this.services.list(targetId);
  }

  @Get("instances/:id")
  @RequirePermissions(PERMISSIONS.MONITORS_READ_ANY)
  get(@Param("id", ParseUUIDPipe) id: string) {
    return this.services.get(id);
  }

  @Get("instances/:id/series")
  @RequirePermissions(PERMISSIONS.MONITORS_READ_ANY)
  series(@Param("id", ParseUUIDPipe) id: string, @Query("from") from?: string, @Query("to") to?: string) {
    const toDate = to ? new Date(to) : new Date();
    const fromDate = from ? new Date(from) : new Date(toDate.getTime() - 6 * 3_600_000);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime()) || fromDate > toDate) throw new BadRequestException("Invalid from/to");
    return this.services.series(id, fromDate, toDate);
  }

  @Get("instances/:id/incidents")
  @RequirePermissions(PERMISSIONS.MONITORS_READ_ANY)
  incidents(@Param("id", ParseUUIDPipe) id: string) {
    return this.services.incidents(id);
  }

  @Post("instances")
  @RequirePermissions(PERMISSIONS.MONITORS_WRITE_ANY)
  @Audited({ action: "service.instance.create", resourceType: "service_instance", redactKeys: ["secrets"] })
  create(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.services.create(parse(serviceInstanceCreateSchema, body), user.id);
  }

  @Patch("instances/:id")
  @RequirePermissions(PERMISSIONS.MONITORS_WRITE_ANY)
  @Audited({ action: "service.instance.update", resourceType: "service_instance", resourceIdFromParams: (p) => p.id ?? null, redactKeys: ["secrets"] })
  update(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.services.update(id, parse(serviceInstanceUpdateSchema, body));
  }

  @Delete("instances/:id")
  @RequirePermissions(PERMISSIONS.MONITORS_WRITE_ANY)
  @Audited({ action: "service.instance.delete", resourceType: "service_instance", resourceIdFromParams: (p) => p.id ?? null })
  remove(@Param("id", ParseUUIDPipe) id: string) {
    return this.services.remove(id);
  }

  @Post("instances/:id/poll-now")
  @OperationalOnly()
  @RequirePermissions(PERMISSIONS.MONITORS_WRITE_ANY)
  @Audited({ action: "service.instance.poll_now", resourceType: "service_instance", resourceIdFromParams: (p) => p.id ?? null })
  async pollNow(@Param("id", ParseUUIDPipe) id: string) {
    const row = await this.services.get(id);
    if (row.status === "disabled") throw new ConflictException("This service, or its host, is switched off");
    if (!(await this.poller.pollNow(id))) throw new ConflictException("It is being checked right now");
    return this.services.get(id);
  }

  /** Runs a template once against a host with the values typed, saving nothing (the template editor and the add dialog). */
  @Post("test")
  @OperationalOnly()
  @RequirePermissions(PERMISSIONS.MONITORS_WRITE_ANY)
  // What a host answered is not kept in the audit log (it can be large and hold data): only that a test ran.
  @Audited({ action: "service.test", resourceType: "infra_target", captureAfter: false })
  test(@Body() body: unknown) {
    return this.services.test(parse(serviceTestSchema, body));
  }

  /** Templates that match what runs on the host: a live look at its units over SSH. */
  @Post("targets/:id/suggestions")
  @OperationalOnly()
  @RequirePermissions(PERMISSIONS.MONITORS_WRITE_ANY)
  @Audited({ action: "service.suggestions", resourceType: "infra_target", resourceIdFromParams: (p) => p.id ?? null, captureAfter: false })
  async suggestions(@Param("id", ParseUUIDPipe) id: string) {
    const units = await this.collector.discoverServices(id);
    return this.services.suggestions(id, units);
  }
}
