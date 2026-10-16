import { Controller, Get } from "@nestjs/common";
import { PERMISSIONS } from "@church/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { SessionOnly } from "../auth/session-only.decorator";
import { SecurityPostureService } from "./security-posture.service";

/** `GET /admin/security-posture`: the checks behind the admin Security overview. Session-only: it maps the site's weak spots. */
@Controller("admin/security-posture")
export class SecurityPostureController {
  constructor(private readonly posture: SecurityPostureService) {}

  @Get()
  @SessionOnly()
  @RequirePermissions(PERMISSIONS.SITE_ADMIN)
  get() {
    return this.posture.report();
  }
}
