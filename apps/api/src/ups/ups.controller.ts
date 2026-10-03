import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  BadRequestException,
} from "@nestjs/common";
import { z } from "zod";
import { PERMISSIONS, createUpsSchema, updateUpsSchema } from "@church/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { Audited } from "../audit/audit.decorator";
import { UpsService } from "./ups.service";

const testBodySchema = z.object({
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535).optional(),
  version: z.enum(["v1", "v2c"]).optional(),
  community: z.string().max(64).optional(),
  timeoutMs: z.number().int().min(500).max(30_000).optional(),
});

// Reuses the monitoring module's permissions (monitors:read/write:any), the
// same pattern as the cisco/ipam monitoring tabs — no dedicated UPS module.
@Controller("ups")
export class UpsController {
  constructor(private readonly ups: UpsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.MONITORS_READ_ANY)
  list() {
    return this.ups.list();
  }

  @Get("summary")
  @RequirePermissions(PERMISSIONS.MONITORS_READ_ANY)
  summary() {
    return this.ups.summary();
  }

  @Get(":id")
  @RequirePermissions(PERMISSIONS.MONITORS_READ_ANY)
  byId(@Param("id") id: string) {
    return this.ups.getById(id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.MONITORS_WRITE_ANY)
  @Audited({ action: "ups.create", resourceType: "ups" })
  async create(@Body() body: unknown) {
    const parsed = createUpsSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.ups.create(parsed.data);
  }

  /** "Test connection" — declared before any `:id` route to keep matching unambiguous. */
  @Post("test")
  @RequirePermissions(PERMISSIONS.MONITORS_WRITE_ANY)
  async test(@Body() body: unknown) {
    const parsed = testBodySchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.ups.testConnection(parsed.data);
  }

  @Patch(":id")
  @RequirePermissions(PERMISSIONS.MONITORS_WRITE_ANY)
  @Audited({
    action: "ups.update",
    resourceType: "ups",
    resourceIdFromParams: (p) => p.id ?? null,
  })
  async update(@Param("id") id: string, @Body() body: unknown) {
    const parsed = updateUpsSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.ups.update(id, parsed.data);
  }

  @Delete(":id")
  @RequirePermissions(PERMISSIONS.MONITORS_WRITE_ANY)
  @Audited({
    action: "ups.delete",
    resourceType: "ups",
    resourceIdFromParams: (p) => p.id ?? null,
  })
  remove(@Param("id") id: string) {
    return this.ups.delete(id);
  }

  /** Manual on-demand refresh. Reads:any suffices — asking for status now is a read. */
  @Post(":id/poll")
  @RequirePermissions(PERMISSIONS.MONITORS_READ_ANY)
  @Audited({
    action: "ups.poll",
    resourceType: "ups",
    resourceIdFromParams: (p) => p.id ?? null,
  })
  poll(@Param("id") id: string) {
    return this.ups.pollOne(id);
  }
}
