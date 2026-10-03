import { Controller, Get, Query } from "@nestjs/common";
import { ActivityService } from "./activity.service";

@Controller("activity")
export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  @Get()
  list(@Query("limit") limit?: string) {
    const n = Math.max(1, Math.min(200, parseInt(limit ?? "50", 10) || 50));
    return this.activity.list(n);
  }
}
