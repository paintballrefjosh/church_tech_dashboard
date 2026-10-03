import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { SettingsService } from "../settings/settings.service";

interface PpConfig {
  host: string;
  port: number;
  password: string;
}

/**
 * ProPresenter 7 HTTP API client. PP7 exposes a REST API on the
 * "Network → Enable Network" port (default 1025). Optional password sent as
 * Basic auth (username left empty).
 *
 * Endpoints used:
 *   GET  /v1/status/slide                — current slide info
 *   GET  /v1/presentation/active         — active presentation
 *   POST /v1/trigger/next                — advance one slide
 *   POST /v1/trigger/previous            — back one slide
 *   POST /v1/clear/layer/all             — blank the output
 *
 * Settings are re-read on every request so an operator can change the host
 * mid-session without restarting the API.
 */
@Injectable()
export class PropresenterService {
  private readonly logger = new Logger(PropresenterService.name);

  constructor(private readonly settings: SettingsService) {}

  private async config(): Promise<PpConfig | null> {
    const host = (await this.settings.get("propresenter.host")) as string | undefined;
    const portRaw = await this.settings.get("propresenter.port");
    const password = ((await this.settings.get("propresenter.password")) as string | undefined) ?? "";
    const port = typeof portRaw === "number" ? portRaw : parseInt(String(portRaw ?? "1025"), 10);
    if (!host) return null;
    return { host, port: Number.isFinite(port) ? port : 1025, password };
  }

  private async request<T = unknown>(
    method: "GET" | "POST",
    path: string,
  ): Promise<T> {
    const cfg = await this.config();
    if (!cfg) {
      throw new ServiceUnavailableException("ProPresenter is not configured");
    }
    const url = `http://${cfg.host}:${cfg.port}${path}`;
    const headers: Record<string, string> = { accept: "application/json" };
    if (cfg.password) {
      headers["authorization"] = `Basic ${Buffer.from(`:${cfg.password}`).toString("base64")}`;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const res = await fetch(url, { method, headers, signal: controller.signal });
      if (!res.ok) {
        throw new ServiceUnavailableException(`ProPresenter ${res.status} ${res.statusText}`);
      }
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("application/json")) return (await res.json()) as T;
      return (await res.text()) as unknown as T;
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") {
        throw new ServiceUnavailableException("ProPresenter timed out");
      }
      this.logger.debug(`ProPresenter ${method} ${path} failed: ${(err as Error).message}`);
      throw new ServiceUnavailableException(
        `ProPresenter unreachable: ${(err as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Connection probe used by the admin settings page's "Test" button. Any
   * field left undefined in `overrides` falls back to the saved settings so
   * a partially-typed form (e.g. host changed but password left as
   * "(unchanged)") still gets a realistic test. Always resolves — never
   * throws — so the UI can surface the message verbatim.
   */
  async testConnection(overrides: {
    host?: string;
    port?: number;
    password?: string;
  }): Promise<{ ok: boolean; message: string }> {
    const stored = await this.config();
    const host = overrides.host?.trim() || stored?.host || "";
    const port =
      typeof overrides.port === "number" && Number.isFinite(overrides.port)
        ? overrides.port
        : stored?.port ?? 1025;
    // Empty string means "the form's secret input was left blank" — fall back
    // to whatever's saved (the form shows "(unchanged)" placeholder for this).
    const password = overrides.password || stored?.password || "";
    if (!host) return { ok: false, message: "Host is required" };
    const url = `http://${host}:${port}/version`;
    const headers: Record<string, string> = { accept: "application/json" };
    if (password) {
      headers["authorization"] = `Basic ${Buffer.from(`:${password}`).toString("base64")}`;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const res = await fetch(url, { method: "GET", headers, signal: controller.signal });
      if (!res.ok) {
        return { ok: false, message: `Connected, but server returned HTTP ${res.status} ${res.statusText}` };
      }
      let detail = "";
      try {
        const body = (await res.json()) as { name?: string; version?: string };
        if (body && (body.name || body.version)) {
          detail = ` — ${body.name ?? "ProPresenter"}${body.version ? ` ${body.version}` : ""}`;
        }
      } catch {
        /* version body isn't JSON in some PP versions; the 200 alone is fine */
      }
      return { ok: true, message: `Connected to ${host}:${port}${detail}` };
    } catch (err) {
      const e = err as { name?: string; message?: string };
      if (e.name === "AbortError") return { ok: false, message: "Connection timed out" };
      return { ok: false, message: e.message || String(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<{ configured: boolean; reachable: boolean; error: string | null }> {
    const cfg = await this.config();
    if (!cfg) return { configured: false, reachable: false, error: null };
    try {
      // Probing /version is the lightest call; it's the canonical "is the
      // remote API alive" endpoint and doesn't depend on a presentation
      // being open.
      await this.request("GET", "/version");
      return { configured: true, reachable: true, error: null };
    } catch (err) {
      return { configured: true, reachable: false, error: (err as Error).message };
    }
  }

  async status(): Promise<{
    slide: unknown | null;
    presentation: unknown | null;
  }> {
    const [slide, presentation] = await Promise.allSettled([
      this.request("GET", "/v1/status/slide"),
      this.request("GET", "/v1/presentation/active"),
    ]);
    return {
      slide: slide.status === "fulfilled" ? slide.value : null,
      presentation: presentation.status === "fulfilled" ? presentation.value : null,
    };
  }

  next() {
    return this.request("POST", "/v1/trigger/next");
  }
  previous() {
    return this.request("POST", "/v1/trigger/previous");
  }
  clearAll() {
    return this.request("POST", "/v1/clear/layer/all");
  }
}
