import { Body, Controller, Post, BadRequestException } from "@nestjs/common";
import { z } from "zod";
import { PERMISSIONS } from "@church/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { MailerService } from "./mailer.service";

const testBodySchema = z.object({
  host: z.string().max(255).optional(),
  port: z.union([z.number().int().min(1).max(65535), z.string()]).optional(),
  username: z.string().max(255).optional(),
  password: z.string().max(512).optional(),
  secure: z.boolean().optional(),
  rejectUnauthorized: z.boolean().optional(),
  fromEmail: z.string().max(254).optional(),
  fromName: z.string().max(120).optional(),
  to: z.string().email().max(254).optional(),
});

/**
 * Admin-only mailer endpoints. Currently just exposes "Test connection",
 * called by the SMTP settings page to verify connectivity against the values
 * in the form (with stored config as the fallback for unsubmitted secrets).
 */
@Controller("mailer")
export class MailerController {
  constructor(private readonly mailer: MailerService) {}

  @Post("test")
  @RequirePermissions(PERMISSIONS.SITE_ADMIN)
  test(@Body() body: unknown) {
    const parsed = testBodySchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const rawPort = parsed.data.port;
    const port =
      typeof rawPort === "number"
        ? rawPort
        : typeof rawPort === "string" && rawPort.trim() !== ""
          ? parseInt(rawPort, 10)
          : undefined;
    return this.mailer.testConnection({
      host: parsed.data.host,
      port: typeof port === "number" && Number.isFinite(port) ? port : undefined,
      username: parsed.data.username,
      password: parsed.data.password,
      secure: parsed.data.secure,
      rejectUnauthorized: parsed.data.rejectUnauthorized,
      fromEmail: parsed.data.fromEmail,
      fromName: parsed.data.fromName,
      to: parsed.data.to,
    });
  }
}
