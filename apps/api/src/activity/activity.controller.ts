import { Controller, Get, Query } from "@nestjs/common";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { ActivityService } from "./activity.service";

@Controller("activity")
export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query("limit") limit?: string) {
    const n = Math.max(1, Math.min(200, parseInt(limit ?? "50", 10) || 50));
    return this.activity.list(user, n);
  }
}
