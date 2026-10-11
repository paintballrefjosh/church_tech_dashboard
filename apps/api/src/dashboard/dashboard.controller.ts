import { Body, Controller, Delete, Get, Put, BadRequestException } from "@nestjs/common";
import { dashboardLayoutSchema, TILE_CATALOGUE, updateDashboardPrefsSchema } from "@church/shared";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { DashboardService } from "./dashboard.service";
import { Audited, SkipAudit } from "../audit/audit.decorator";

@Controller("dashboard")
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  /** Static — anyone signed in can list tiles available to add. */
  @Get("tiles")
  catalogue() {
    return TILE_CATALOGUE;
  }

  @Get("layout")
  async getLayout(@CurrentUser() user: AuthenticatedUser) {
    return { layout: await this.dashboard.getLayout(user.id) };
  }

  // Layout saves fire on every drag/resize — auditing would flood without
  // adding any meaningful signal. The user is editing their own preference.
  @Put("layout")
  @SkipAudit()
  async saveLayout(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const parsed = dashboardLayoutSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    await this.dashboard.saveLayout(user.id, parsed.data.layout);
    return { ok: true };
  }

  @Get("prefs")
  async getPrefs(@CurrentUser() user: AuthenticatedUser) {
    return this.dashboard.getPrefs(user.id, user.permissions);
  }

  /** The response carries `id` (the user id) so the audit row's resource id is the user. */
  @Put("prefs")
  @Audited({ action: "dashboard.prefs.update", resourceType: "dashboard_prefs", captureAfter: false })
  async updatePrefs(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const parsed = updateDashboardPrefsSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const view = await this.dashboard.updatePrefs(user.id, user.permissions, parsed.data);
    return { id: user.id, ...view };
  }

  @Delete("layout")
  @SkipAudit()
  async reset(@CurrentUser() user: AuthenticatedUser) {
    await this.dashboard.reset(user.id);
    return { ok: true };
  }
}
