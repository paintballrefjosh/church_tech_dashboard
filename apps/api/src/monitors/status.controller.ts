import { Controller, Get } from "@nestjs/common";
import { StatusService } from "./status.service";

/** Any signed-in person (the session guard still applies); no module permission, by design. */
@Controller("status")
export class StatusController {
  constructor(private readonly status: StatusService) {}

  @Get()
  page() {
    return this.status.page();
  }
}
