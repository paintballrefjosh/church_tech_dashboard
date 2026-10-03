import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Agent } from "undici";
import { eq, inArray } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { unifiDeviceAcks } from "../db/schema";
import { SettingsService } from "../settings/settings.service";

/** Normalise a MAC for storage/comparison — controllers report lowercase, but
 * be defensive about whatever the client echoes back into the ack URL. */
function normMac(mac: string): string {
  return mac.trim().toLowerCase();
}

interface UnifiConfig {
  baseUrl: string;
  apiKey: string;
  siteId: string;
  verifyTls: boolean;
}

// UniFi rows are deeply nested and vary between firmware versions; we read only
// the handful of fields we aggregate over and ignore the rest.
interface UDevice {
  state?: number;
  mac?: string;
  name?: string;
  model?: string;
}
interface UClient {
  is_wired?: boolean;
}

/**
 * A network/VLAN definition from the controller's `rest/networkconf` — the
 * authoritative source of LAN CIDRs the IPAM discovery feeds on. Returned close
 * to raw (only the fields IPAM needs); CIDR normalisation/gateway extraction is
 * done by the IPAM discovery so this stays a thin pass-through.
 */
export interface UnifiNetwork {
  name: string;
  /** Raw controller value, e.g. "10.0.10.1/24" (host bits included). */
  ipSubnet: string | null;
  vlanId: number | null;
  purpose: string | null; // corporate | guest | vlan-only | wan | …
  enabled: boolean;
}

interface UNetworkConf {
  name?: string;
  ip_subnet?: string;
  vlan_enabled?: boolean;
  vlan?: number | string;
  enabled?: boolean;
  purpose?: string;
}

export interface UnifiSummary {
  configured: boolean;
  reachable: boolean;
  error: string | null;
  // `acked` counts currently-offline devices an operator has acknowledged; the
  // Network tab badge subtracts these so a known-down device stops nagging.
  devices: { total: number; online: number; offline: number; acked: number };
  clients: { total: number; wired: number; wireless: number };
}

// Requests are cheap but the controller can be slow or unreachable; cap every
// call so the Network page / dashboard tile / Test button never hang.
const REQUEST_TIMEOUT_MS = 8_000;

/**
 * undici's `fetch` reports transport failures as a generic `TypeError: fetch
 * failed` and hides the real reason on `.cause`. Unwrap it so the operator
 * sees the actionable error (self-signed cert, connection refused, DNS, …)
 * on the Network page and the Test button.
 */
function describeFetchError(err: unknown): Error {
  const e = err as { message?: string; cause?: { code?: string; message?: string } };
  const cause = e?.cause;
  if (cause?.code === "DEPTH_ZERO_SELF_SIGNED_CERT" || cause?.code === "SELF_SIGNED_CERT_IN_CHAIN") {
    return new Error(
      "TLS certificate is self-signed. Turn off \"Verify TLS\" for this controller, or install a trusted cert.",
    );
  }
  if (cause?.code) return new Error(`${cause.code}${cause.message ? ` (${cause.message})` : ""}`);
  if (cause?.message) return new Error(cause.message);
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Read-only UniFi Network Application client. Settings (URL, API key, site,
 * verify-tls) live in the DB so an operator can rotate the key at runtime
 * without redeploying. We re-read on every request — values rarely change
 * and the cost is one settings table lookup.
 *
 * Auth: API keys introduced in UniFi Network 9.x sent as `X-API-Key`. The
 * controller exposes data at /proxy/network/api/s/<site>/stat/* on UniFi OS
 * devices (UDM family), or /api/s/<site>/stat/* on self-hosted Network apps.
 * We try the UniFi OS path first and fall back so a single setting works for
 * both deployments.
 */
@Injectable()
export class UnifiService {
  private readonly logger = new Logger(UnifiService.name);

  constructor(
    private readonly settings: SettingsService,
    @Inject(DB) private readonly db: Db,
  ) {}

  /**
   * Given a freshly-fetched device list, (1) delete any ack whose device is now
   * online — an ack only covers the *current* offline episode, so recovery
   * clears it and a later re-offline counts again — then (2) return the set of
   * MACs that remain acknowledged. Runs on every controller read so recovery is
   * reconciled even when nobody is watching the live Network page. Never clears
   * on an empty/unreachable read (no device reports state===1, so nothing is
   * treated as recovered).
   */
  private async reconcileAcks(devices: UDevice[]): Promise<Set<string>> {
    const acks = await this.db.select({ mac: unifiDeviceAcks.mac }).from(unifiDeviceAcks);
    if (acks.length === 0) return new Set();
    const ackedMacs = new Set(acks.map((a) => a.mac));
    const recovered = devices
      .filter((d) => d.state === 1 && d.mac && ackedMacs.has(normMac(d.mac)))
      .map((d) => normMac(d.mac as string));
    if (recovered.length > 0) {
      await this.db.delete(unifiDeviceAcks).where(inArray(unifiDeviceAcks.mac, recovered));
      for (const mac of recovered) ackedMacs.delete(mac);
    }
    return ackedMacs;
  }

  /** Tag each raw device with an `acked` flag for the table UI. */
  private annotate(devices: unknown[], ackedMacs: Set<string>): unknown[] {
    return devices.map((raw) => {
      const d = raw as UDevice;
      return { ...(raw as object), acked: !!(d.mac && ackedMacs.has(normMac(d.mac))) };
    });
  }

  private async config(): Promise<UnifiConfig | null> {
    const baseUrl = (await this.settings.get("unifi.controller_url")) as string | undefined;
    const apiKey = (await this.settings.get("unifi.api_key")) as string | undefined;
    const siteId = ((await this.settings.get("unifi.site_id")) as string | undefined) ?? "default";
    const verifyTls = ((await this.settings.get("unifi.verify_tls")) as boolean | undefined) ?? false;
    if (!baseUrl || !apiKey) return null;
    return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, siteId, verifyTls };
  }

  /**
   * GET a UniFi Network API path. Tries `/proxy/network/api/...` (UniFi OS)
   * first; if that 404s falls back to `/api/...` (self-hosted controller).
   * The caller passes the path *after* the `api/` prefix — e.g.
   * `s/default/stat/device`.
   */
  private async apiGet(path: string): Promise<unknown> {
    const cfg = await this.config();
    if (!cfg) {
      throw new ServiceUnavailableException("UniFi controller is not configured");
    }
    return this.fetchWith(cfg, path);
  }

  /**
   * GET a UniFi Network API path against an explicit config. Split out from
   * `apiGet` so the Test-connection probe can exercise *unsaved* form values
   * without persisting them first. Tries the UniFi-OS path then falls back to
   * the self-hosted one, and bounds each attempt with a timeout.
   */
  private async fetchWith(cfg: UnifiConfig, path: string): Promise<unknown> {
    const headers: Record<string, string> = {
      "X-API-Key": cfg.apiKey,
      accept: "application/json",
    };
    // Node's global `fetch` is undici-based and IGNORES the legacy `agent`
    // option — the only way to scope a TLS-verify override to this request is
    // an undici `Agent` passed as `dispatcher`. Controllers ship a self-signed
    // cert by default, so `verify_tls` is off unless the operator opts in.
    const dispatcher = new Agent({ connect: { rejectUnauthorized: cfg.verifyTls } });
    const candidates = [
      `${cfg.baseUrl}/proxy/network/api/${path}`,
      `${cfg.baseUrl}/api/${path}`,
    ];
    let lastErr: unknown = null;
    for (const url of candidates) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          method: "GET",
          headers,
          dispatcher,
          signal: controller.signal,
        } as RequestInit & { dispatcher: Agent });
        if (res.status === 404) continue;
        if (!res.ok) {
          throw new ServiceUnavailableException(`UniFi ${res.status} ${res.statusText}`);
        }
        const body = (await res.json()) as { data?: unknown };
        return body?.data ?? body;
      } catch (err) {
        lastErr =
          (err as Error)?.name === "AbortError"
            ? new Error(`timed out after ${REQUEST_TIMEOUT_MS}ms`)
            : describeFetchError(err);
        this.logger.debug(`UniFi GET ${url} failed: ${(lastErr as Error).message}`);
      } finally {
        clearTimeout(timer);
      }
    }
    throw new ServiceUnavailableException(
      `UniFi unreachable: ${lastErr instanceof Error ? lastErr.message : "unknown"}`,
    );
  }

  async devices(): Promise<unknown[]> {
    const cfg = await this.config();
    if (!cfg) return [];
    const data = await this.apiGet(`s/${encodeURIComponent(cfg.siteId)}/stat/device`);
    const raw = Array.isArray(data) ? data : [];
    const ackedMacs = await this.reconcileAcks(raw as UDevice[]);
    return this.annotate(raw, ackedMacs);
  }

  async clients(): Promise<unknown[]> {
    const cfg = await this.config();
    if (!cfg) return [];
    const data = await this.apiGet(`s/${encodeURIComponent(cfg.siteId)}/stat/sta`);
    return Array.isArray(data) ? data : [];
  }

  /**
   * The controller's configured networks/VLANs (`rest/networkconf`) — the LAN
   * CIDRs the IPAM discovery derives scan ranges from. Always resolves; returns
   * `[]` when the controller is unconfigured or unreachable (IPAM discovery
   * treats UniFi as just one of several sources, so a miss is non-fatal).
   */
  async networks(): Promise<UnifiNetwork[]> {
    const cfg = await this.config();
    if (!cfg) return [];
    let data: unknown;
    try {
      data = await this.apiGet(`s/${encodeURIComponent(cfg.siteId)}/rest/networkconf`);
    } catch (err) {
      this.logger.debug(`UniFi networkconf failed: ${(err as Error).message}`);
      return [];
    }
    const rows = Array.isArray(data) ? (data as UNetworkConf[]) : [];
    return rows.map((n) => ({
      name: (n.name ?? "").trim() || "network",
      ipSubnet: typeof n.ip_subnet === "string" && n.ip_subnet.trim() ? n.ip_subnet.trim() : null,
      vlanId: n.vlan_enabled && n.vlan != null ? Number(n.vlan) || null : null,
      purpose: n.purpose ?? null,
      enabled: n.enabled !== false,
    }));
  }

  async health(): Promise<{ configured: boolean; reachable: boolean; error: string | null }> {
    const cfg = await this.config();
    if (!cfg) return { configured: false, reachable: false, error: null };
    try {
      await this.apiGet(`s/${encodeURIComponent(cfg.siteId)}/stat/health`);
      return { configured: true, reachable: true, error: null };
    } catch (err) {
      return { configured: true, reachable: false, error: (err as Error).message };
    }
  }

  /**
   * Full view the Network tab renders: connection health plus the raw device
   * and client lists. Two controller round-trips. Always resolves — on failure
   * the health block carries the reason and the lists come back empty. Used by
   * the realtime poller to push a complete snapshot to subscribers.
   */
  async snapshot(): Promise<{
    health: { configured: boolean; reachable: boolean; error: string | null };
    devices: unknown[];
    clients: unknown[];
  }> {
    const cfg = await this.config();
    if (!cfg) {
      return { health: { configured: false, reachable: false, error: null }, devices: [], clients: [] };
    }
    try {
      const site = encodeURIComponent(cfg.siteId);
      const [rawDevices, rawClients] = await Promise.all([
        this.fetchWith(cfg, `s/${site}/stat/device`),
        this.fetchWith(cfg, `s/${site}/stat/sta`),
      ]);
      const devices = Array.isArray(rawDevices) ? rawDevices : [];
      const ackedMacs = await this.reconcileAcks(devices as UDevice[]);
      return {
        health: { configured: true, reachable: true, error: null },
        devices: this.annotate(devices, ackedMacs),
        clients: Array.isArray(rawClients) ? rawClients : [],
      };
    } catch (err) {
      return {
        health: { configured: true, reachable: false, error: (err as Error).message },
        devices: [],
        clients: [],
      };
    }
  }

  /**
   * Aggregate device/client counts for the dashboard tile. One round-trip per
   * list; always resolves so the tile can render a "not configured" /
   * "unreachable" state without throwing.
   */
  async summary(): Promise<UnifiSummary> {
    const empty = {
      devices: { total: 0, online: 0, offline: 0, acked: 0 },
      clients: { total: 0, wired: 0, wireless: 0 },
    };
    const cfg = await this.config();
    if (!cfg) return { configured: false, reachable: false, error: null, ...empty };
    try {
      const site = encodeURIComponent(cfg.siteId);
      const [rawDevices, rawClients] = await Promise.all([
        this.fetchWith(cfg, `s/${site}/stat/device`),
        this.fetchWith(cfg, `s/${site}/stat/sta`),
      ]);
      const devices = (Array.isArray(rawDevices) ? rawDevices : []) as UDevice[];
      const clients = (Array.isArray(rawClients) ? rawClients : []) as UClient[];
      const ackedMacs = await this.reconcileAcks(devices);
      const online = devices.filter((d) => d.state === 1).length;
      // Offline devices the operator has acknowledged — excluded from the tab badge.
      const acked = devices.filter(
        (d) => d.state !== 1 && d.mac && ackedMacs.has(normMac(d.mac)),
      ).length;
      const wired = clients.filter((c) => c.is_wired).length;
      return {
        configured: true,
        reachable: true,
        error: null,
        devices: { total: devices.length, online, offline: devices.length - online, acked },
        clients: { total: clients.length, wired, wireless: clients.length - wired },
      };
    } catch (err) {
      return { configured: true, reachable: false, error: (err as Error).message, ...empty };
    }
  }

  /**
   * Connection probe for the admin settings "Test" button. Any field left
   * undefined in `overrides` falls back to the saved settings so a partially
   * filled form (e.g. URL changed but API key left as "(unchanged)") still
   * gets a realistic test. Always resolves — never throws — so the UI can
   * surface the message verbatim.
   */
  async testConnection(overrides: {
    baseUrl?: string;
    apiKey?: string;
    siteId?: string;
    verifyTls?: boolean;
  }): Promise<{ ok: boolean; message: string }> {
    const stored = await this.config();
    const baseUrl = (overrides.baseUrl?.trim() || stored?.baseUrl || "").replace(/\/+$/, "");
    // Empty string means the masked API-key input was left blank — fall back to
    // whatever's saved (the form shows "(unchanged)" for this).
    const apiKey = overrides.apiKey || stored?.apiKey || "";
    const siteId = overrides.siteId?.trim() || stored?.siteId || "default";
    const verifyTls =
      typeof overrides.verifyTls === "boolean" ? overrides.verifyTls : stored?.verifyTls ?? false;
    if (!baseUrl) return { ok: false, message: "Controller URL is required" };
    if (!apiKey) return { ok: false, message: "API key is required" };
    try {
      await this.fetchWith(
        { baseUrl, apiKey, siteId, verifyTls },
        `s/${encodeURIComponent(siteId)}/stat/health`,
      );
      return { ok: true, message: `Connected to ${baseUrl} (site "${siteId}")` };
    } catch (err) {
      return { ok: false, message: (err as Error).message || String(err) };
    }
  }

  /**
   * Acknowledge a currently-offline device so it stops counting toward the
   * Network tab problem badge. Refuses to ack an online device (there's nothing
   * to acknowledge, and reconciliation would drop it on the next read anyway).
   * Upserts so re-acking just refreshes who/when.
   */
  async ackDevice(mac: string, userId: string | null): Promise<{ mac: string; acked: boolean }> {
    const normalized = normMac(mac);
    if (!normalized) throw new BadRequestException("mac is required");
    const devices = (await this.devices()) as UDevice[];
    const dev = devices.find((d) => d.mac && normMac(d.mac) === normalized);
    if (!dev) throw new NotFoundException("Device not found");
    if (dev.state === 1) throw new BadRequestException("Device is online; nothing to acknowledge");
    const name = dev.name || dev.model || normalized;
    await this.db
      .insert(unifiDeviceAcks)
      .values({ mac: normalized, deviceName: name, ackedByUserId: userId, ackedAt: new Date() })
      .onConflictDoUpdate({
        target: unifiDeviceAcks.mac,
        set: { deviceName: name, ackedByUserId: userId, ackedAt: new Date() },
      });
    return { mac: normalized, acked: true };
  }

  /** Clear an ack (device counts again immediately). Idempotent. */
  async unackDevice(mac: string): Promise<{ mac: string; acked: boolean }> {
    const normalized = normMac(mac);
    if (!normalized) throw new BadRequestException("mac is required");
    await this.db.delete(unifiDeviceAcks).where(eq(unifiDeviceAcks.mac, normalized));
    return { mac: normalized, acked: false };
  }
}
