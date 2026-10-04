import { Agent } from "undici";
import type { DnsRecordData } from "@church/shared";

/**
 * Minimal typed client for the Technitium DNS Server HTTP API
 * (https://github.com/TechnitiumSoftware/DnsServer/blob/master/APIDOCS.md).
 *
 * Auth is an API token sent as `Authorization: Bearer` (v15+; older servers
 * also accept it). Never put the token in the query string — URLs end up in
 * logs. Every response is `{status, response?, errorMessage?}`; anything other
 * than `status: "ok"` becomes a TechnitiumError.
 */
export interface TechnitiumConfig {
  baseUrl: string;
  apiToken: string;
  verifyTls: boolean;
}

/**
 * `unreachable` = transport failure or timeout; `auth` = the token was
 * rejected; `api` = Technitium answered with an error (e.g. access denied).
 */
export type TechnitiumErrorKind = "unreachable" | "auth" | "api";

export class TechnitiumError extends Error {
  constructor(
    message: string,
    readonly kind: TechnitiumErrorKind,
  ) {
    super(message);
    this.name = "TechnitiumError";
  }
}

// Cap every call so the DNS tab, tab badge and Test button never hang on a
// dead node.
const REQUEST_TIMEOUT_MS = 8_000;

// Node's global `fetch` ignores the legacy `agent` option; an undici `Agent`
// passed as `dispatcher` is the only way to scope the TLS-verify override to
// these requests. One per mode so connections are pooled across calls.
const verifyingAgent = new Agent({ connect: { rejectUnauthorized: true } });
const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });

/** Unwrap undici's generic "fetch failed" into the actionable cause. */
function describeFetchError(err: unknown): string {
  const e = err as { message?: string; cause?: { code?: string; message?: string } };
  const cause = e?.cause;
  if (cause?.code === "DEPTH_ZERO_SELF_SIGNED_CERT" || cause?.code === "SELF_SIGNED_CERT_IN_CHAIN") {
    return 'TLS certificate is self-signed. Turn off "Verify Technitium TLS certificate", or install a trusted cert.';
  }
  if (cause?.code) return `${cause.code}${cause.message ? ` (${cause.message})` : ""}`;
  if (cause?.message) return cause.message;
  return err instanceof Error ? err.message : String(err);
}

interface Envelope {
  status?: string;
  response?: unknown;
  errorMessage?: string;
}

export type TechnitiumParams = Record<string, string | number | boolean | undefined>;

/**
 * Call an API path (e.g. `zones/list`). Reads go as GET query parameters;
 * writes (`method: "POST"`) send them as a form body so record values and
 * comments stay out of URLs/access logs. Returns the `response` object, or the
 * whole body for the few calls (session/get) that put their fields at the top
 * level.
 */
export async function technitiumCall<T>(
  cfg: TechnitiumConfig,
  path: string,
  params: TechnitiumParams = {},
  method: "GET" | "POST" = "GET",
): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.set(k, String(v));
  }
  const query = qs.toString();
  const url =
    method === "GET" && query ? `${cfg.baseUrl}/api/${path}?${query}` : `${cfg.baseUrl}/api/${path}`;
  const headers: Record<string, string> = {
    authorization: `Bearer ${cfg.apiToken}`,
    accept: "application/json",
  };
  if (method === "POST") headers["content-type"] = "application/x-www-form-urlencoded";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: method === "POST" ? query : undefined,
      dispatcher: cfg.verifyTls ? verifyingAgent : insecureAgent,
      signal: controller.signal,
    } as RequestInit & { dispatcher: Agent });
  } catch (err) {
    const msg =
      (err as Error)?.name === "AbortError"
        ? `timed out after ${REQUEST_TIMEOUT_MS}ms`
        : describeFetchError(err);
    throw new TechnitiumError(`Technitium unreachable: ${msg}`, "unreachable");
  } finally {
    clearTimeout(timer);
  }

  let body: Envelope;
  try {
    body = (await res.json()) as Envelope;
  } catch {
    throw new TechnitiumError(
      `Technitium returned HTTP ${res.status} with a non-JSON body — is the URL the web console's?`,
      "unreachable",
    );
  }
  if (body.status === "invalid-token") {
    throw new TechnitiumError("Technitium rejected the API token (invalid or expired)", "auth");
  }
  if (body.status !== "ok") {
    throw new TechnitiumError(body.errorMessage || `Technitium error (HTTP ${res.status})`, "api");
  }
  return (body.response ?? body) as T;
}

// ---- raw response shapes (only the fields we read) ----

export interface TSessionInfo {
  username?: string;
  info?: {
    version?: string;
    dnsServerDomain?: string;
    clusterInitialized?: boolean;
    clusterDomain?: string;
    permissions?: Record<string, { canView?: boolean; canModify?: boolean; canDelete?: boolean }>;
  };
}

export interface TClusterState {
  clusterInitialized?: boolean;
  dnsServerDomain?: string;
  version?: string;
  clusterNodes?: Array<{
    name?: string;
    url?: string;
    ipAddress?: string;
    type?: string;
    state?: string;
    version?: string;
    lastSeen?: string;
  }>;
}

export interface TZone {
  name?: string;
  type?: string;
  internal?: boolean;
  disabled?: boolean;
  dnssecStatus?: string;
  soaSerial?: number;
  lastModified?: string;
  syncFailed?: boolean;
  notifyFailed?: boolean;
  isExpired?: boolean;
}

export interface TRecord {
  name?: string;
  type?: string;
  ttl?: number;
  disabled?: boolean;
  comments?: string;
  rData?: Record<string, unknown>;
}

export interface TTopEntry {
  name?: string;
  domain?: string;
  hits?: number;
}

export interface TStats {
  stats?: Record<string, number | undefined>;
  topClients?: TTopEntry[];
  topDomains?: TTopEntry[];
  topBlockedDomains?: TTopEntry[];
}

/** Technitium's "never" timestamp. */
const NEVER = "0001-01-01T00:00:00";

export function tsOrNull(v: string | undefined): string | null {
  return v && !v.startsWith(NEVER) ? v : null;
}

/**
 * Structured rData for the types the dashboard edits, or null for anything
 * else (or an rData missing required fields).
 */
export function parseRData(type: string, rData: Record<string, unknown> | undefined): DnsRecordData | null {
  if (!rData) return null;
  const str = (k: string): string | null => (typeof rData[k] === "string" ? (rData[k] as string) : null);
  const num = (k: string): number | null => (typeof rData[k] === "number" ? (rData[k] as number) : null);
  switch (type) {
    case "A":
    case "AAAA": {
      const ipAddress = str("ipAddress");
      return ipAddress ? { type, ipAddress } : null;
    }
    case "CNAME": {
      const cname = str("cname");
      return cname ? { type, cname } : null;
    }
    case "PTR": {
      const ptrName = str("ptrName");
      return ptrName ? { type, ptrName } : null;
    }
    case "MX": {
      const preference = num("preference");
      const exchange = str("exchange");
      return preference !== null && exchange ? { type, preference, exchange } : null;
    }
    case "TXT": {
      const text = str("text");
      return text !== null ? { type, text, splitText: rData.splitText === true } : null;
    }
    case "SRV": {
      const [priority, weight, port] = [num("priority"), num("weight"), num("port")];
      const target = str("target");
      return priority !== null && weight !== null && port !== null && target
        ? { type, priority, weight, port, target }
        : null;
    }
    default:
      return null;
  }
}

/**
 * Technitium parameters identifying a record's data (add, delete, and the
 * "current value" half of an update).
 */
export function dataParams(data: DnsRecordData): TechnitiumParams {
  switch (data.type) {
    case "A":
    case "AAAA":
      return { ipAddress: data.ipAddress };
    case "CNAME":
      return { cname: data.cname };
    case "PTR":
      return { ptrName: data.ptrName };
    case "MX":
      return { preference: data.preference, exchange: data.exchange };
    case "TXT":
      return { text: data.text, splitText: data.splitText };
    case "SRV":
      return { priority: data.priority, weight: data.weight, port: data.port, target: data.target };
  }
}

/**
 * The "new value" half of an update. Technitium prefixes each field with
 * `new` (ipAddress → newIpAddress) — except CNAME, which has a single `cname`
 * since a name can only hold one CNAME.
 */
export function newDataParams(data: DnsRecordData): TechnitiumParams {
  if (data.type === "CNAME") return { cname: data.cname };
  const out: TechnitiumParams = {};
  for (const [k, v] of Object.entries(dataParams(data))) {
    out[`new${k.charAt(0).toUpperCase()}${k.slice(1)}`] = v;
  }
  return out;
}

/** Compare two records' data for identity (case-insensitive names, canonical IPv6). */
export function sameData(a: DnsRecordData, b: DnsRecordData): boolean {
  if (a.type !== b.type) return false;
  const norm = (d: DnsRecordData): string => {
    const p = dataParams(d);
    if (d.type === "AAAA") p.ipAddress = canonicalIpv6(d.ipAddress);
    // Domain-valued fields compare case-insensitively without a trailing dot;
    // TXT text is case-sensitive and kept verbatim.
    for (const k of ["cname", "ptrName", "exchange", "target"]) {
      const v = p[k];
      if (typeof v === "string") p[k] = v.toLowerCase().replace(/\.$/, "");
    }
    return JSON.stringify(p);
  };
  return norm(a) === norm(b);
}

/** Expand an IPv6 address to its full 8-group lowercase form for comparison. */
function canonicalIpv6(ip: string): string {
  const [head, tail] = ip.toLowerCase().split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const groups =
    tail === undefined ? h : [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return groups.map((g) => g.padStart(4, "0")).join(":");
}

/**
 * Render a record's rData to one display string. Covers the types people
 * actually manage; anything else falls back to compact `key=value` pairs.
 */
export function formatRData(type: string, rData: Record<string, unknown> | undefined): string {
  if (!rData) return "";
  const s = (k: string): string => {
    const v = rData[k];
    return v === undefined || v === null ? "" : String(v);
  };
  switch (type) {
    case "A":
    case "AAAA":
      return s("ipAddress");
    case "CNAME":
      return s("cname");
    case "PTR":
      return s("ptrName");
    case "NS":
      return s("nameServer");
    case "DNAME":
      return s("dname");
    case "ANAME":
      return s("aname");
    case "MX":
      return `${s("preference")} ${s("exchange")}`;
    case "TXT":
      return s("text");
    case "SRV":
      return `${s("priority")} ${s("weight")} ${s("port")} ${s("target")}`;
    case "CAA":
      return `${s("flags")} ${s("tag")} "${s("value")}"`;
    case "SOA":
      return `${s("primaryNameServer")} ${s("responsiblePerson")} serial ${s("serial")}`;
    case "FWD":
      return `${s("protocol")} ${s("forwarder")}`.trim();
    default:
      return Object.entries(rData)
        .filter(([, v]) => v !== null && typeof v !== "object")
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(" ");
  }
}
