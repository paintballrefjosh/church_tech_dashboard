import { BadRequestException, Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { PERMISSIONS, createLocationSchema, updateLocationSchema } from "@church/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { Audited } from "../audit/audit.decorator";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { LocationsService } from "./locations.service";

export function parseBody<T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { flatten: () => unknown } } }, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
  return parsed.data;
}

/** Rooms. Reading needs only a session (a ticket form lists them, like `/status`); editing needs `locations:admin`. */
@Controller("locations")
export class LocationsController {
  constructor(private readonly rooms: LocationsService) {}

  @Get()
  list() {
    return this.rooms.list();
  }

  @Post()
  @RequirePermissions(PERMISSIONS.LOCATIONS_ADMIN)
  @Audited({ action: "location.create", resourceType: "location" })
  create(@Body() body: unknown) {
    return this.rooms.create(parseBody(createLocationSchema, body));
  }

  @Get(":id")
  get(@Param("id", ParseUUIDPipe) id: string) {
    return this.rooms.get(id);
  }

  /** What is in the room, limited to what the reader may see. */
  @Get(":id/summary")
  summary(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.rooms.summary(id, user);
  }

  /** How many things point at it (what deleting it clears). */
  @Get(":id/usage")
  @RequirePermissions(PERMISSIONS.LOCATIONS_ADMIN)
  usage(@Param("id", ParseUUIDPipe) id: string) {
    return this.rooms.usage(id);
  }

  @Patch(":id")
  @RequirePermissions(PERMISSIONS.LOCATIONS_ADMIN)
  @Audited({ action: "location.update", resourceType: "location", resourceIdFromParams: (p) => p.id ?? null })
  update(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.rooms.update(id, parseBody(updateLocationSchema, body));
  }

  @Delete(":id")
  @RequirePermissions(PERMISSIONS.LOCATIONS_ADMIN)
  @Audited({ action: "location.delete", resourceType: "location", resourceIdFromParams: (p) => p.id ?? null })
  async remove(@Param("id", ParseUUIDPipe) id: string) {
    await this.rooms.remove(id);
    return { ok: true };
  }
}
