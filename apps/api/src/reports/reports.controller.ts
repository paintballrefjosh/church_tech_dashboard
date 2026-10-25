import { BadRequestException, Controller, Get, Query } from "@nestjs/common";
import { isReportMonth, previousMonth } from "@church/shared";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { NotificationDeliveryService } from "../notifications/notification-delivery.service";
import { ReportsService } from "./reports.service";

/** The monthly report for any month (default: last month). Site admins and the report's group; no module permission. */
@Controller("reports")
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly delivery: NotificationDeliveryService,
  ) {}

  @Get("monthly")
  async monthly(@CurrentUser() user: AuthenticatedUser, @Query("month") month?: string) {
    await this.reports.assertCanRead(user);
    const m = month ?? previousMonth(new Date(), await this.delivery.zone());
    if (!isReportMonth(m)) throw new BadRequestException("month must look like 2026-10");
    return this.reports.build(m);
  }
}
