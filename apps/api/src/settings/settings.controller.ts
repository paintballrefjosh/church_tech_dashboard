import {
  Controller,
  Get,
  Put,
  Delete,
  Param,
  Body,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import { z } from "zod";
import {
  PERMISSIONS,
  findKnownSetting,
  settingCategory,
  categoryManagePermission,
} from "@church/shared";
import { Public } from "../auth/public.decorator";
import { Audited } from "../audit/audit.decorator";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { SettingsService } from "./settings.service";

const setBody = z.object({ value: z.unknown() });
const keyRe = /^[a-z][a-z0-9._-]{0,127}$/;

/**
 * Per-category authorisation. Settings are no longer uniformly site-admin gated:
 * a module admin (e.g. printers:admin) may read AND write that module's settings
 * category — including secrets — without being a site admin. Core categories
 * (site/auth/oauth/smtp/...) map to a null manage-permission, so only site:admin
 * may write them; a settings:read:any role may still read them (redacted).
 *
 * canWrite(category) = site:admin OR holds the category's manage permission
 * canRead(category)  = canWrite OR settings:read:any
 * Keys with no known category are treated as core (site:admin only).
 */
function canWriteCategory(user: AuthenticatedUser, category: string | null): boolean {
  if (user.permissions.includes(PERMISSIONS.SITE_ADMIN)) return true;
  const manage = categoryManagePermission(category);
  return manage !== null && user.permissions.includes(manage);
}

function canReadCategory(user: AuthenticatedUser, category: string | null): boolean {
  if (canWriteCategory(user, category)) return true;
  return user.permissions.includes(PERMISSIONS.SETTINGS_READ_ANY);
}

/**
 * Replace a secret value with a sentinel (set/unset) so callers who can't manage
 * the category see *whether* a secret exists without seeing the secret itself.
 * The settings form pre-fills the field with the same sentinel so the operator
 * can tell at a glance whether the value is configured.
 */
const SECRET_PLACEHOLDER = "********";
function presentValue(user: AuthenticatedUser, key: string, value: unknown): unknown {
  if (findKnownSetting(key)?.type !== "secret") return value;
  if (canWriteCategory(user, settingCategory(key))) return value;
  if (value === null || value === undefined || value === "") return null;
  return SECRET_PLACEHOLDER;
}

@Controller("settings")
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  /**
   * Public chrome values used by the sign-in page and the footer — anything
   * here renders before a session exists, so it must be safe to expose. The
   * key list is an explicit allowlist so a future sensitive setting (e.g.
   * an SMTP password) can't accidentally leak through this endpoint.
   */
  @Public()
  @Get("public")
  async publicChrome() {
    const [siteName, siteTagline, footerMessage] = await Promise.all([
      this.settings.get("site.name"),
      this.settings.get("site.tagline"),
      this.settings.get("site.footer_message"),
    ]);
    return {
      siteName: typeof siteName === "string" ? siteName : "",
      siteTagline: typeof siteTagline === "string" ? siteTagline : "",
      footerMessage: typeof footerMessage === "string" ? footerMessage : "",
    };
  }

  @Get()
  async list(@CurrentUser() user: AuthenticatedUser) {
    const items = await this.settings.list();
    // Each caller only sees the categories they can read; secrets are redacted
    // unless they can manage (write) that category. A module admin therefore
    // sees just their module's settings, with its secrets in the clear.
    const visible = items
      .filter((it) => canReadCategory(user, settingCategory(it.key)))
      .map((it) => ({ ...it, value: presentValue(user, it.key, it.value) }));
    return { items: visible };
  }

  @Get(":key")
  async getOne(@Param("key") key: string, @CurrentUser() user: AuthenticatedUser) {
    if (!keyRe.test(key)) throw new BadRequestException("invalid key");
    const category = settingCategory(key);
    if (!canReadCategory(user, category)) {
      throw new ForbiddenException("You don't have permission to read this setting.");
    }
    const value = await this.settings.get(key);
    return { key, value: presentValue(user, key, value) ?? null };
  }

  @Put(":key")
  @Audited({ action: "setting.set", resourceType: "setting", resourceIdFromParams: (p) => p.key ?? null })
  async set(@Param("key") key: string, @Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    if (!keyRe.test(key)) throw new BadRequestException("invalid key");
    if (!canWriteCategory(user, settingCategory(key))) {
      throw new ForbiddenException("You don't have permission to change this setting.");
    }
    const parsed = setBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    await this.settings.set(key, parsed.data.value, user?.id ?? null);
    return { ok: true, key };
  }

  @Delete(":key")
  @Audited({ action: "setting.delete", resourceType: "setting", resourceIdFromParams: (p) => p.key ?? null })
  async remove(@Param("key") key: string, @CurrentUser() user: AuthenticatedUser) {
    if (!keyRe.test(key)) throw new BadRequestException("invalid key");
    if (!canWriteCategory(user, settingCategory(key))) {
      throw new ForbiddenException("You don't have permission to delete this setting.");
    }
    await this.settings.delete(key);
    return { ok: true };
  }
}
