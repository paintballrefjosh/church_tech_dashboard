import { Controller, Get, Post, Patch, Delete, Param, ParseUUIDPipe, Body, BadRequestException } from "@nestjs/common";
import { PERMISSIONS, createRackSchema, updateRackSchema, createRackItemSchema, updateRackItemSchema } from "@church/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { Audited } from "../audit/audit.decorator";
import { RacksService } from "./racks.service";
import { PortSheetsService } from "./port-sheets.service";

/**
 * Cabinets (racks). Like Cisco, IPAM and the UPS tab these ride the monitoring tiers: anyone who can see monitoring reads
 * them, the monitoring admin tier changes them. Placing an item changes only this dashboard's record of where a device
 * sits; nothing is sent to any device, so none of it is operational-only.
 */
const READ = PERMISSIONS.MONITORS_READ_ANY;
const WRITE = PERMISSIONS.MONITORS_WRITE_ANY;

function parse<T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { flatten: () => unknown } } }, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
  return parsed.data;
}

@Controller("racks")
export class RacksController {
  constructor(private readonly racks: RacksService) {}

  @Get()
  @RequirePermissions(READ)
  list() {
    return this.racks.list();
  }

  /** Devices that could be placed (Cisco switches, infrastructure hosts, UniFi devices), with where each already sits. */
  @Get("candidates")
  @RequirePermissions(READ)
  candidates() {
    return this.racks.candidates();
  }

  @Post()
  @RequirePermissions(WRITE)
  @Audited({ action: "rack.create", resourceType: "rack" })
  create(@Body() body: unknown) {
    return this.racks.create(parse(createRackSchema, body));
  }

  @Get(":id")
  @RequirePermissions(READ)
  get(@Param("id", ParseUUIDPipe) id: string) {
    return this.racks.get(id);
  }

  @Patch(":id")
  @RequirePermissions(WRITE)
  @Audited({ action: "rack.update", resourceType: "rack", resourceIdFromParams: (p) => p.id ?? null })
  update(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.racks.update(id, parse(updateRackSchema, body));
  }

  @Delete(":id")
  @RequirePermissions(WRITE)
  @Audited({ action: "rack.delete", resourceType: "rack", resourceIdFromParams: (p) => p.id ?? null })
  async remove(@Param("id", ParseUUIDPipe) id: string) {
    await this.racks.remove(id);
    return { ok: true };
  }

  @Post(":id/items")
  @RequirePermissions(WRITE)
  @Audited({ action: "rack.item.add", resourceType: "rack", resourceIdFromParams: (p) => p.id ?? null })
  addItem(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.racks.addItem(id, parse(createRackItemSchema, body));
  }

  @Patch(":id/items/:itemId")
  @RequirePermissions(WRITE)
  @Audited({ action: "rack.item.update", resourceType: "rack", resourceIdFromParams: (p) => p.id ?? null })
  updateItem(@Param("id", ParseUUIDPipe) id: string, @Param("itemId", ParseUUIDPipe) itemId: string, @Body() body: unknown) {
    return this.racks.updateItem(id, itemId, parse(updateRackItemSchema, body));
  }

  @Delete(":id/items/:itemId")
  @RequirePermissions(WRITE)
  @Audited({ action: "rack.item.remove", resourceType: "rack", resourceIdFromParams: (p) => p.id ?? null })
  async removeItem(@Param("id", ParseUUIDPipe) id: string, @Param("itemId", ParseUUIDPipe) itemId: string) {
    await this.racks.removeItem(id, itemId);
    return { ok: true };
  }
}

/** The data for the printable port sheets of a Cisco switch and a UniFi switch. Read-only. */
@Controller("port-sheets")
export class PortSheetsController {
  constructor(private readonly sheets: PortSheetsService) {}

  @Get("cisco/:id")
  @RequirePermissions(READ)
  cisco(@Param("id", ParseUUIDPipe) id: string) {
    return this.sheets.forCisco(id);
  }

  @Get("unifi/:mac")
  @RequirePermissions(PERMISSIONS.UNIFI_READ_ANY)
  unifi(@Param("mac") mac: string) {
    return this.sheets.forUnifi(mac);
  }
}
