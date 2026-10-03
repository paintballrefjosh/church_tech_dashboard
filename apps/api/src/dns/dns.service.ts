import {
  Injectable,
  BadRequestException,
  BadGatewayException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type {
  DnsNode,
  DnsRecord,
  DnsStats,
  DnsStatsRange,
  DnsSummary,
  DnsTestInput,
  DnsTopEntry,
  DnsZone,
} from "@church/shared";
import { SettingsService } from "../settings/settings.service";
import {
  technitiumCall,
  TechnitiumError,
  tsOrNull,
  formatRData,
  type TechnitiumConfig,
  type TSessionInfo,
  type TClusterState,
  type TZone,
  type TRecord,
  type TStats,
  type TTopEntry,
} from "./technitium";

// DNSSEC bookkeeping records — noise in a records table; Technitium manages them.
const HIDDEN_RECORD_TYPES = new Set(["RRSIG", "NSEC", "NSEC3", "NSEC3PARAM", "DNSKEY"]);

// Cluster member states that count as healthy.
const HEALTHY_NODE_STATES = new Set(["Self", "Connected"]);

// Zone names as they appear in a path segment: labels of letters, digits, `-`
// and `_`, dot-separated (reverse zones like `10.10.in-addr.arpa` included).
const ZONE_NAME_RE = /^(?=.{1,253}$)[a-z0-9_-]+(\.[a-z0-9_-]+)*\.?$/i;

/**
 * Monitoring → DNS. Read-only view over a Technitium DNS Server cluster
 * (phase 1): connection/cluster health, zones, records, query stats. Settings
 * are re-read on every request so a rotated token or a new primary URL after a
 * failover takes effect immediately.
 */
@Injectable()
export class DnsService {
  constructor(private readonly settings: SettingsService) {}

  private async config(): Promise<TechnitiumConfig | null> {
    const baseUrl = (await this.settings.get("dns.primary_url")) as string | undefined;
    const apiToken = (await this.settings.get("dns.api_token")) as string | undefined;
    const verifyTls = ((await this.settings.get("dns.verify_tls")) as boolean | undefined) ?? false;
    if (!baseUrl?.trim() || !apiToken) return null;
    return { baseUrl: baseUrl.trim().replace(/\/+$/, ""), apiToken, verifyTls };
  }

  private async requireConfig(): Promise<TechnitiumConfig> {
    const cfg = await this.config();
    if (!cfg) throw new ServiceUnavailableException("DNS is not configured");
    return cfg;
  }

  /** Map a client error to the HTTP error the controller surfaces. */
  private toHttp(err: unknown): Error {
    if (err instanceof TechnitiumError) {
      return err.kind === "api"
        ? new BadGatewayException(err.message)
        : new ServiceUnavailableException(err.message);
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  /**
   * Tab badge + Overview header. Always resolves: on failure `reachable` is
   * false and `error` carries the reason.
   */
  async summary(): Promise<DnsSummary> {
    const empty: DnsSummary = {
      configured: false,
      reachable: false,
      error: null,
      version: null,
      server: null,
      clustered: false,
      nodes: null,
      zoneCount: 0,
      unreachableNodes: 0,
    };
    const cfg = await this.config();
    if (!cfg) return empty;
    try {
      const [session, zones, cluster] = await Promise.all([
        technitiumCall<TSessionInfo>(cfg, "user/session/get"),
        technitiumCall<{ zones?: TZone[] }>(cfg, "zones/list"),
        // The node list needs Administration: View; without it the rest of
        // the summary is still useful, so a refusal just means "no nodes".
        technitiumCall<TClusterState>(cfg, "admin/cluster/state").catch((err: unknown) => {
          if (err instanceof TechnitiumError && err.kind === "api") return null;
          throw err;
        }),
      ]);
      const clustered = Boolean(session.info?.clusterInitialized ?? cluster?.clusterInitialized);
      const nodes: DnsNode[] | null =
        clustered && cluster?.clusterNodes
          ? cluster.clusterNodes.map((n) => ({
              name: n.name ?? "",
              url: n.url ?? null,
              ipAddress: n.ipAddress ?? null,
              type: n.type ?? "Unknown",
              state: n.state ?? "Unknown",
              version: n.version ?? null,
              lastSeen: tsOrNull(n.lastSeen),
            }))
          : null;
      return {
        configured: true,
        reachable: true,
        error: null,
        version: session.info?.version ?? cluster?.version ?? null,
        server: session.info?.dnsServerDomain ?? cluster?.dnsServerDomain ?? null,
        clustered,
        nodes,
        zoneCount: (zones.zones ?? []).filter((z) => !z.internal).length,
        unreachableNodes: nodes ? nodes.filter((n) => !HEALTHY_NODE_STATES.has(n.state)).length : 0,
      };
    } catch (err) {
      return { ...empty, configured: true, error: (err as Error).message };
    }
  }

  /** Authoritative zones, built-in internal ones (localhost, 0.in-addr.arpa…) hidden. */
  async zones(): Promise<DnsZone[]> {
    const cfg = await this.config();
    if (!cfg) return [];
    let res: { zones?: TZone[] };
    try {
      res = await technitiumCall<{ zones?: TZone[] }>(cfg, "zones/list");
    } catch (err) {
      throw this.toHttp(err);
    }
    return (res.zones ?? [])
      .filter((z) => !z.internal && z.name)
      .map((z) => ({
        name: z.name ?? "",
        type: z.type ?? "Unknown",
        disabled: Boolean(z.disabled),
        dnssecStatus: z.dnssecStatus ?? null,
        soaSerial: typeof z.soaSerial === "number" ? z.soaSerial : null,
        lastModified: tsOrNull(z.lastModified),
        syncFailed: Boolean(z.syncFailed),
        notifyFailed: Boolean(z.notifyFailed),
        isExpired: Boolean(z.isExpired),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Every record in one zone, DNSSEC bookkeeping types hidden. */
  async records(zone: string): Promise<DnsRecord[]> {
    if (!ZONE_NAME_RE.test(zone)) throw new BadRequestException("Invalid zone name");
    const cfg = await this.requireConfig();
    let res: { records?: TRecord[] };
    try {
      res = await technitiumCall<{ records?: TRecord[] }>(cfg, "zones/records/get", {
        domain: zone,
        zone,
        listZone: true,
      });
    } catch (err) {
      throw this.toHttp(err);
    }
    return (res.records ?? [])
      .filter((r) => r.type && !HIDDEN_RECORD_TYPES.has(r.type))
      .map((r) => ({
        name: r.name ?? "",
        type: r.type ?? "",
        ttl: typeof r.ttl === "number" ? r.ttl : 0,
        value: formatRData(r.type ?? "", r.rData),
        disabled: Boolean(r.disabled),
        comments: r.comments?.trim() ? r.comments : null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type) || a.value.localeCompare(b.value));
  }

  /**
   * Query stats for the Overview. Cluster-wide (`node=cluster`) when the
   * cluster is initialised, else the single node's.
   */
  async stats(range: DnsStatsRange): Promise<DnsStats> {
    const cfg = await this.requireConfig();
    try {
      const session = await technitiumCall<TSessionInfo>(cfg, "user/session/get");
      const cluster = Boolean(session.info?.clusterInitialized);
      const res = await technitiumCall<TStats>(cfg, "dashboard/stats/get", {
        type: range,
        utc: true,
        node: cluster ? "cluster" : undefined,
      });
      const st = res.stats ?? {};
      const n = (k: string): number => Math.trunc(st[k] ?? 0);
      const top = (rows: TTopEntry[] | undefined): DnsTopEntry[] =>
        (rows ?? []).map((r) => ({ name: r.name ?? "", domain: r.domain ?? null, hits: Math.trunc(r.hits ?? 0) }));
      return {
        range,
        cluster,
        totals: {
          queries: n("totalQueries"),
          noError: n("totalNoError"),
          serverFailure: n("totalServerFailure"),
          nxDomain: n("totalNxDomain"),
          refused: n("totalRefused"),
          authoritative: n("totalAuthoritative"),
          recursive: n("totalRecursive"),
          cached: n("totalCached"),
          blocked: n("totalBlocked"),
          dropped: n("totalDropped"),
          clients: n("totalClients"),
        },
        topClients: top(res.topClients),
        topDomains: top(res.topDomains),
        topBlockedDomains: top(res.topBlockedDomains),
      };
    } catch (err) {
      throw this.toHttp(err);
    }
  }

  /**
   * Settings-page "Test connection". Falls back to saved values for anything
   * the form left out. Reports which Technitium view permissions the token is
   * missing, since a token that authenticates but can't see zones looks like
   * an empty server otherwise. Always resolves.
   */
  async testConnection(overrides: DnsTestInput): Promise<{ ok: boolean; message: string }> {
    const stored = await this.config();
    const baseUrl = (overrides.baseUrl?.trim() || stored?.baseUrl || "").replace(/\/+$/, "");
    // Empty token = the masked secret input was left as "(unchanged)".
    const apiToken = overrides.apiToken || stored?.apiToken || "";
    const verifyTls =
      typeof overrides.verifyTls === "boolean" ? overrides.verifyTls : stored?.verifyTls ?? false;
    if (!baseUrl) return { ok: false, message: "Technitium primary URL is required" };
    if (!/^https?:\/\//i.test(baseUrl)) {
      return { ok: false, message: "Technitium primary URL must start with http:// or https://" };
    }
    if (!apiToken) return { ok: false, message: "Technitium API token is required" };
    try {
      const session = await technitiumCall<TSessionInfo>(
        { baseUrl, apiToken, verifyTls },
        "user/session/get",
      );
      const info = session.info ?? {};
      const perms = info.permissions ?? {};
      const missing = ["Dashboard", "Zones", "Administration"].filter((s) => !perms[s]?.canView);
      const where = info.dnsServerDomain ?? baseUrl;
      const cluster = info.clusterInitialized
        ? `, cluster ${info.clusterDomain ?? "initialised"}`
        : ", not clustered";
      const base = `Connected to ${where} as ${session.username ?? "?"} (Technitium ${info.version ?? "?"}${cluster})`;
      if (missing.length > 0) {
        // Zones/Dashboard are required for the tab to work; Administration
        // only powers the node list.
        const fatal = missing.some((s) => s !== "Administration");
        return { ok: !fatal, message: `${base}. Token lacks View on: ${missing.join(", ")}.` };
      }
      return { ok: true, message: `${base}.` };
    } catch (err) {
      return { ok: false, message: (err as Error).message || String(err) };
    }
  }
}
