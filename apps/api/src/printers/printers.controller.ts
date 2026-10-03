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
import {
  PERMISSIONS,
  createPrinterSchema,
  updatePrinterSchema,
} from "@church/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { Audited } from "../audit/audit.decorator";
import { PrintersService } from "./printers.service";

const testBodySchema = z.object({
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535).optional(),
  version: z.enum(["v1", "v2c"]).optional(),
  community: z.string().max(64).optional(),
  timeoutMs: z.number().int().min(500).max(30_000).optional(),
});

@Controller("printers")
export class PrintersController {
  constructor(private readonly printers: PrintersService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.PRINTERS_READ_ANY)
  list() {
    return this.printers.list();
  }

  @Get("summary")
  @RequirePermissions(PERMISSIONS.PRINTERS_READ_ANY)
  summary() {
    return this.printers.summary();
  }

  @Get(":id")
  @RequirePermissions(PERMISSIONS.PRINTERS_READ_ANY)
  byId(@Param("id") id: string) {
    return this.printers.getById(id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.PRINTERS_ADMIN)
  @Audited({ action: "printer.create", resourceType: "printer" })
  async create(@Body() body: unknown) {
    const parsed = createPrinterSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.printers.create(parsed.data);
  }

  /**
   * "Test connection" button on the printer Add/Edit dialog. Probes the
   * supplied host over SNMP, using global defaults when per-printer fields
   * are left blank. Declared before any `:id` POST to keep route matching
   * unambiguous.
   */
  @Post("test")
  @RequirePermissions(PERMISSIONS.PRINTERS_ADMIN)
  async test(@Body() body: unknown) {
    const parsed = testBodySchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.printers.testConnection(parsed.data);
  }

  @Patch(":id")
  @RequirePermissions(PERMISSIONS.PRINTERS_ADMIN)
  @Audited({
    action: "printer.update",
    resourceType: "printer",
    resourceIdFromParams: (p) => p.id ?? null,
  })
  async update(@Param("id") id: string, @Body() body: unknown) {
    const parsed = updatePrinterSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.printers.update(id, parsed.data);
  }

  @Delete(":id")
  @RequirePermissions(PERMISSIONS.PRINTERS_ADMIN)
  @Audited({
    action: "printer.delete",
    resourceType: "printer",
    resourceIdFromParams: (p) => p.id ?? null,
  })
  remove(@Param("id") id: string) {
    return this.printers.delete(id);
  }

  /**
   * Manual on-demand refresh. Reads:any is enough because viewing the current
   * status of a printer is the same operation as asking it for status now —
   * we're not changing config.
   */
  @Post(":id/poll")
  @RequirePermissions(PERMISSIONS.PRINTERS_READ_ANY)
  @Audited({
    action: "printer.poll",
    resourceType: "printer",
    resourceIdFromParams: (p) => p.id ?? null,
  })
  poll(@Param("id") id: string) {
    return this.printers.pollOne(id);
  }
}
