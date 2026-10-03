import { Body, Controller, Delete, Get, Put, BadRequestException } from "@nestjs/common";
import { dashboardLayoutSchema, TILE_CATALOGUE } from "@church/shared";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { DashboardService } from "./dashboard.service";
import { SkipAudit } from "../audit/audit.decorator";

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

  @Delete("layout")
  @SkipAudit()
  async reset(@CurrentUser() user: AuthenticatedUser) {
    await this.dashboard.reset(user.id);
    return { ok: true };
  }
}
