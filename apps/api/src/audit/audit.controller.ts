import { Controller, Get, Query, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { auditListQuerySchema, PERMISSIONS } from "@church/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { AuditService } from "./audit.service";

function parseDateLoose(s: string | undefined): Date | undefined {
  if (!s) return undefined;
  // Accept full ISO datetimes or YYYY-MM-DD (treated as midnight UTC).
  const value = /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00.000Z` : s;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

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
      from: parseDateLoose(parsed.from),
      to: parseDateLoose(parsed.to),
    });
    return { items: rows };
  }

  /**
   * CSV export of the filtered range. Same filters as the list endpoint,
   * larger default limit, and the response is streamed as text/csv with a
   * download filename. Used by the /admin/audit "Export CSV" button.
   */
  @Get("export.csv")
  async exportCsv(@Query() query: unknown, @Res() reply: FastifyReply) {
    const parsed = auditListQuerySchema.parse(query);
    const rows = await this.audit.list({
      limit: Math.min(parsed.limit, 10_000),
      cursor: parsed.cursor ? new Date(parsed.cursor) : undefined,
      actorUserId: parsed.actorUserId,
      resourceType: parsed.resourceType,
      action: parsed.action,
      from: parseDateLoose(parsed.from),
      to: parseDateLoose(parsed.to),
    });
    const header = ["ts", "actorEmail", "action", "resourceType", "resourceId", "ip", "userAgent"];
    const lines = [
      header.join(","),
      ...rows.map((r) =>
        [
          r.ts.toISOString(),
          r.actorEmail ?? "",
          r.action,
          r.resourceType,
          r.resourceId ?? "",
          r.ip ?? "",
          r.userAgent ?? "",
        ]
          .map(csvField)
          .join(","),
      ),
    ];
    const body = `${lines.join("\n")}\n`;
    const filename = `audit-${new Date().toISOString().slice(0, 10)}.csv`;
    void reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="${filename}"`)
      .header("x-content-type-options", "nosniff")
      .send(body);
  }
}

/** RFC-4180-ish escape: wrap in quotes if needed, double internal quotes. */
function csvField(v: string): string {
  if (v === "") return "";
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}
