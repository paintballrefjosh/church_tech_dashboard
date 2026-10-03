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
  /**
   * Mirrors nodemailer's tls.rejectUnauthorized. Default true. Operators can
   * flip this off in /admin/settings/smtp when relaying through an internal
   * server with a self-signed cert.
   */
  rejectUnauthorized: boolean;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** Optional HTML body. When set, the message is sent as a multipart with
   *  text/html alongside the plain-text fallback. */
  html?: string;
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
interface MailQueueRef {
  enqueue(msg: MailMessage): Promise<void>;
}

@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  /** Optional queue, set by MailQueue at module init. When present
   *  sendBestEffort enqueues; otherwise it sends inline. */
  private queue: MailQueueRef | null = null;

  constructor(private readonly settings: SettingsService) {}

  /** Called by MailQueue once during bootstrap. Setter injection to avoid
   *  a constructor-level circular dependency between Mailer + queue. */
  setQueue(q: MailQueueRef): void {
    this.queue = q;
  }

  async sendBestEffort(msg: MailMessage): Promise<void> {
    if (this.queue) {
      try {
        await this.queue.enqueue(msg);
      } catch (err) {
        this.logger.warn(`mail enqueue failed: ${(err as Error).message}`);
      }
      return;
    }
    try {
      await this.sendNow(msg);
    } catch (err) {
      this.logger.warn(
        `mailer: failed to send to ${msg.to}: ${(err as Error).message}`,
      );
    }
  }

  /** Actually send via SMTP. Public so the queue worker can call it. */
  async sendNow(msg: MailMessage): Promise<void> {
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
      tls: { rejectUnauthorized: cfg.rejectUnauthorized },
    });
    const from = cfg.fromName
      ? `"${cfg.fromName.replace(/"/g, "")}" <${cfg.fromEmail}>`
      : cfg.fromEmail;
    await transporter.sendMail({
      from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      ...(msg.html ? { html: msg.html } : {}),
    });
    this.logger.debug(`mailer: sent ${msg.subject} -> ${msg.to}`);
  }

  /**
   * Connection probe used by the admin SMTP settings page. Builds a one-off
   * transporter from `overrides ∪ stored`, runs `transporter.verify()`, and
   * optionally sends a one-line test mail when `to` is set. Always resolves
   * — never throws — so the UI surfaces the message verbatim.
   */
  async testConnection(overrides: {
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    secure?: boolean;
    rejectUnauthorized?: boolean;
    fromEmail?: string;
    fromName?: string;
    to?: string;
  }): Promise<{ ok: boolean; message: string }> {
    const stored = await this.loadConfig();
    const host = overrides.host?.trim() || stored?.host || "";
    const port =
      typeof overrides.port === "number" && Number.isFinite(overrides.port)
        ? overrides.port
        : stored?.port ?? 25;
    // Empty username/password = "form field blank" — fall back to stored.
    const username = overrides.username || stored?.username || "";
    const password = overrides.password || stored?.password || "";
    const secure = overrides.secure ?? stored?.secure ?? false;
    const rejectUnauthorized =
      overrides.rejectUnauthorized ?? stored?.rejectUnauthorized ?? true;
    const fromEmail = overrides.fromEmail?.trim() || stored?.fromEmail || "";
    const fromName = overrides.fromName ?? stored?.fromName ?? "";
    if (!host) return { ok: false, message: "Host is required" };
    if (!Number.isFinite(port) || port <= 0) return { ok: false, message: "Port is required" };

    const transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: username ? { user: username, pass: password } : undefined,
      tls: { rejectUnauthorized },
      connectionTimeout: 8_000,
      greetingTimeout: 8_000,
      socketTimeout: 8_000,
    });
    try {
      await transporter.verify();
      if (overrides.to && fromEmail) {
        const from = fromName ? `"${fromName.replace(/"/g, "")}" <${fromEmail}>` : fromEmail;
        await transporter.sendMail({
          from,
          to: overrides.to,
          subject: "Church Dashboard — SMTP test",
          text: `If you're reading this, SMTP is wired up correctly.\nServer: ${host}:${port}`,
        });
        return { ok: true, message: `Connected and sent a test email to ${overrides.to}` };
      }
      return { ok: true, message: `Connected to ${host}:${port}${username ? ` as ${username}` : ""}` };
    } catch (err) {
      return { ok: false, message: (err as Error).message || String(err) };
    } finally {
      try {
        transporter.close();
      } catch {
        /* nodemailer's close is best-effort */
      }
    }
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
    // Default true — strict verification matches the existing behaviour before
    // this setting was introduced, so untouched installs keep their guarantees.
    const rawReject = await this.settings.get("smtp.reject_unauthorized");
    const rejectUnauthorized = typeof rawReject === "boolean" ? rawReject : true;
    if (!Number.isFinite(port) || port <= 0) return null;
    return { host, port, username, password, fromEmail, fromName, secure, rejectUnauthorized };
  }
}
