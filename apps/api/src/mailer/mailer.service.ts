import { Injectable, Logger } from "@nestjs/common";
import nodemailer, { type Transporter } from "nodemailer";
import { SettingsService } from "../settings/settings.service";

interface SmtpConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  fromEmail: string;
  fromName: string;
  secure: boolean;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * Sends mail via SMTP using settings drawn from the DB at send time.
 *
 * Send is fire-and-forget at the call site: callers use sendBestEffort() which
 * always resolves. Failures (missing config, SMTP unreachable, etc.) are
 * logged and dropped — they never block the caller's request. We don't cache
 * the transporter because settings are mutable from the admin UI and we want
 * changes to take effect immediately.
 */
@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);

  constructor(private readonly settings: SettingsService) {}

  async sendBestEffort(msg: MailMessage): Promise<void> {
    try {
      await this.send(msg);
    } catch (err) {
      this.logger.warn(
        `mailer: failed to send to ${msg.to}: ${(err as Error).message}`,
      );
    }
  }

  private async send(msg: MailMessage): Promise<void> {
    const cfg = await this.loadConfig();
    if (!cfg) {
      // No usable config — silently skip. This is the normal state on a fresh
      // install before the operator wires up SMTP via /admin/settings.
      return;
    }
    const transporter: Transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: cfg.username
        ? { user: cfg.username, pass: cfg.password }
        : undefined,
    });
    const from = cfg.fromName
      ? `"${cfg.fromName.replace(/"/g, "")}" <${cfg.fromEmail}>`
      : cfg.fromEmail;
    await transporter.sendMail({
      from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
    });
    this.logger.debug(`mailer: sent ${msg.subject} -> ${msg.to}`);
  }

  private async loadConfig(): Promise<SmtpConfig | null> {
    const host = (await this.settings.get("smtp.host")) as string | undefined;
    const fromEmail = (await this.settings.get("smtp.from_email")) as string | undefined;
    if (!host || !fromEmail) return null;
    const port = Number((await this.settings.get("smtp.port")) ?? 25);
    const username = ((await this.settings.get("smtp.username")) as string | undefined) ?? "";
    const password = ((await this.settings.get("smtp.password")) as string | undefined) ?? "";
    const fromName = ((await this.settings.get("smtp.from_name")) as string | undefined) ?? "";
    const secure = Boolean((await this.settings.get("smtp.secure")) ?? false);
    if (!Number.isFinite(port) || port <= 0) return null;
    return { host, port, username, password, fromEmail, fromName, secure };
  }
}
