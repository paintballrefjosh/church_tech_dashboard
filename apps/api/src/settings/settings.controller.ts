import { Controller, Get, Put, Delete, Param, Body, BadRequestException } from "@nestjs/common";
import { z } from "zod";
import { PERMISSIONS } from "@church/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { Audited } from "../audit/audit.decorator";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { SettingsService } from "./settings.service";

const setBody = z.object({ value: z.unknown() });
const keyRe = /^[a-z][a-z0-9._-]{0,127}$/;

@Controller("settings")
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.SETTINGS_READ_ANY)
  list() {
    return this.settings.list().then((items) => ({ items }));
  }

  @Get(":key")
  @RequirePermissions(PERMISSIONS.SETTINGS_READ_ANY)
  async getOne(@Param("key") key: string) {
    if (!keyRe.test(key)) throw new BadRequestException("invalid key");
    const value = await this.settings.get(key);
    return { key, value: value ?? null };
  }

  @Put(":key")
  @RequirePermissions(PERMISSIONS.SETTINGS_WRITE_ANY)
  @Audited({ action: "setting.set", resourceType: "setting", resourceIdFromParams: (p) => p.key ?? null })
  async set(@Param("key") key: string, @Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    if (!keyRe.test(key)) throw new BadRequestException("invalid key");
    const parsed = setBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    await this.settings.set(key, parsed.data.value, user?.id ?? null);
    return { ok: true, key };
  }

  @Delete(":key")
  @RequirePermissions(PERMISSIONS.SETTINGS_WRITE_ANY)
  @Audited({ action: "setting.delete", resourceType: "setting", resourceIdFromParams: (p) => p.key ?? null })
  async remove(@Param("key") key: string) {
    if (!keyRe.test(key)) throw new BadRequestException("invalid key");
    await this.settings.delete(key);
    return { ok: true };
  }
}
