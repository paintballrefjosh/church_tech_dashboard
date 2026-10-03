/**
 * Small IPv4 CIDR helpers for the IPAM scanner. Everything works on unsigned
 * 32-bit integers (`>>> 0` keeps JS bitwise ops unsigned). No IPv6 — the church
 * LAN is v4-only and the scanner's ICMP/TCP probes assume v4 addresses.
 */

export function ipToInt(ip: string): number | null {
  const parts = ip.trim().split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const o = Number(p);
    if (o > 255) return null;
    n = ((n << 8) | o) >>> 0;
  }
  return n >>> 0;
}

export function intToIp(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

export interface ParsedCidr {
  /** Normalised "network/prefix", e.g. 10.0.10.0/24 (host bits cleared). */
  cidr: string;
  prefix: number;
  network: number;
  broadcast: number;
  /** Usable host count (excludes network + broadcast for prefixes ≤ /30). */
  hostCount: number;
}

export function parseCidr(input: string): ParsedCidr | null {
  const m = /^\s*(\d+\.\d+\.\d+\.\d+)\/(\d+)\s*$/.exec(input);
  if (!m) return null;
  const ipInt = ipToInt(m[1]!);
  const prefix = Number(m[2]);
  if (ipInt === null || prefix < 0 || prefix > 32) return null;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ipInt & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  const span = broadcast - network + 1;
  const hostCount = prefix >= 31 ? span : Math.max(0, span - 2);
  return { cidr: `${intToIp(network)}/${prefix}`, prefix, network, broadcast, hostCount };
}

/**
 * Normalise a controller-style CIDR that carries host bits (e.g. UniFi's
 * `ip_subnet` = "10.0.10.1/24") into the network CIDR plus the gateway host it
 * named. Returns null when unparseable.
 */
export function normalizeCidr(input: string): { cidr: string; gateway: string | null } | null {
  const m = /^\s*(\d+\.\d+\.\d+\.\d+)\/(\d+)\s*$/.exec(input);
  if (!m) return null;
  const p = parseCidr(input);
  const host = ipToInt(m[1]!);
  if (!p || host === null) return null;
  const gateway = host !== p.network && host !== p.broadcast ? intToIp(host) : null;
  return { cidr: p.cidr, gateway };
}

/**
 * Expand a CIDR to its scannable host addresses (network + broadcast excluded
 * for prefixes ≤ /30). Bounded by `cap`; the caller can tell it truncated by
 * comparing the returned length against `parseCidr().hostCount`.
 */
export function expandHosts(cidr: string, cap: number): string[] {
  const p = parseCidr(cidr);
  if (!p) return [];
  const out: string[] = [];
  const [lo, hi] = p.prefix >= 31 ? [p.network, p.broadcast] : [p.network + 1, p.broadcast - 1];
  for (let n = lo; n <= hi && out.length < cap; n++) out.push(intToIp(n >>> 0));
  return out;
}

/** The containing /24 for an IP — used to infer subnets from loose ARP host IPs. */
export function ipToSlash24(ip: string): string | null {
  const n = ipToInt(ip);
  if (n === null) return null;
  return `${intToIp((n & 0xffffff00) >>> 0)}/24`;
}
