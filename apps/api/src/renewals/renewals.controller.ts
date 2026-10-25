import { BadRequestException, Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { PERMISSIONS, createRenewalSchema, updateRenewalSchema } from "@church/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { Audited } from "../audit/audit.decorator";
import { RenewalsService } from "./renewals.service";

/** Renewals ride the monitoring tiers, like cabinets and IPAM: anyone with Monitoring reads them, its admin tier edits. */
const READ = PERMISSIONS.MONITORS_READ_ANY;
const WRITE = PERMISSIONS.MONITORS_WRITE_ANY;

function parse<T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { flatten: () => unknown } } }, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
  return parsed.data;
}

@Controller("renewals")
export class RenewalsController {
  constructor(private readonly renewals: RenewalsService) {}

  @Get()
  @RequirePermissions(READ)
  list() {
    return this.renewals.list();
  }

  @Post()
  @RequirePermissions(WRITE)
  @Audited({ action: "renewal.create", resourceType: "renewal" })
  create(@Body() body: unknown) {
    return this.renewals.create(parse(createRenewalSchema, body));
  }

  @Get(":id")
  @RequirePermissions(READ)
  get(@Param("id", ParseUUIDPipe) id: string) {
    return this.renewals.get(id);
  }

  @Patch(":id")
  @RequirePermissions(WRITE)
  @Audited({ action: "renewal.update", resourceType: "renewal", resourceIdFromParams: (p) => p.id ?? null })
  update(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.renewals.update(id, parse(updateRenewalSchema, body));
  }

  @Delete(":id")
  @RequirePermissions(WRITE)
  @Audited({ action: "renewal.delete", resourceType: "renewal", resourceIdFromParams: (p) => p.id ?? null })
  async remove(@Param("id", ParseUUIDPipe) id: string) {
    await this.renewals.remove(id);
    return { ok: true };
  }
}
