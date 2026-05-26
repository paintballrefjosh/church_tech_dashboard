import { Controller, Get, Query } from "@nestjs/common";
import { auditListQuerySchema, PERMISSIONS } from "@church/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { AuditService } from "./audit.service";

@Controller("audit")
@RequirePermissions(PERMISSIONS.AUDIT_READ_ANY)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  async list(@Query() query: unknown) {
    const parsed = auditListQuerySchema.parse(query);
    const rows = await this.audit.list({
      limit: parsed.limit,
      cursor: parsed.cursor ? new Date(parsed.cursor) : undefined,
      actorUserId: parsed.actorUserId,
      resourceType: parsed.resourceType,
      action: parsed.action,
    });
    return { items: rows };
  }
}
