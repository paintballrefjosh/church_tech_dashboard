import {
  DNS_MANAGED_MARKER,
  type DnsSyncAction,
  type DnsSyncConflict,
  type DnsSyncHostOutcome,
  type DnsSyncPlan,
  type DnsSyncRecordType,
} from "@church/shared";

/**
 * Pure IPAM -> DNS diff. Given the hosts IPAM says should be published and the
 * records Technitium currently holds, work out the changes. No I/O, so the
 * preview, the real run and the unit tests all share it.
 *
 * Ownership rule: a record is the sync's if and only if its comment carries
 * DNS_MANAGED_MARKER. The sync only ever changes or removes such records; a
 * hand-made record at a name it wants is a conflict, never overwritten.
 */

export interface PlanHost {
  id: string;
  ipAddress: string;
  /** Operator override; wins over discovered names and over collisions. */
  dnsName: string | null;
  unifiName: string | null;
  netbiosName: string | null;
  lastSeenAt: Date | null;
}

export interface ExistingRecord {
  zone: string;
  name: string;
  type: string;
  value: string;
  ttl: number;
  comments: string | null;
}

export interface PlanInput {
  enabled: boolean;
  /** Forward zone A records go into. */
  zone: string;
  ptr: boolean;
  ttl: number;
  staleDays: number;
  now: Date;
  hosts: PlanHost[];
  /** Every authoritative zone Technitium hosts (to find reverse zones). */
  zones: string[];
  /** Records from every zone the sync touches (forward, reverse, ledger zones). */
  existing: ExistingRecord[];
  /** Ledger key (`zone|name|type`) -> ipam host id, for removal reasons. */
  ledger: Map<string, string | null>;
}

// Removing more than this many records in one run needs an explicit force.
const SAFETY_MAX_REMOVALS = 20;
// …or more than this share of the managed set, once past a small floor.
const SAFETY_MAX_SHARE = 0.25;
const SAFETY_SHARE_FLOOR = 5;

const lc = (s: string): string => s.toLowerCase().replace(/\.$/, "");
export const recordKey = (zone: string, name: string, type: string): string =>
  `${lc(zone)}|${lc(name)}|${type.toUpperCase()}`;
const isManaged = (r: ExistingRecord): boolean => Boolean(r.comments?.includes(DNS_MANAGED_MARKER));

/**
 * Turn a discovered name into one DNS label: "Josh's iPhone" -> "joshs-iphone",
 * "OFFICE-PC" -> "office-pc", "laptop.lan" -> "laptop". Null when nothing usable
 * remains.
 */
export function toDnsLabel(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim();
  // A DHCP hostname that is already dotted (laptop.lan) keeps its first label.
  if (/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(s)) s = s.split(".")[0] ?? "";
  s = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (s.length > 63) s = s.slice(0, 63).replace(/-+$/, "");
  return s || null;
}

/** "10.0.10.25" -> "25.10.0.10.in-addr.arpa". */
export function ptrName(ip: string): string {
  return `${ip.split(".").reverse().join(".")}.in-addr.arpa`;
}

/** Longest hosted reverse zone containing `name`, or null. */
function reverseZoneFor(name: string, zones: string[]): string | null {
  let best: string | null = null;
  for (const z of zones) {
    if (!z.endsWith("in-addr.arpa")) continue;
    if ((name === z || name.endsWith(`.${z}`)) && (!best || z.length > best.length)) best = z;
  }
  return best;
}

/** Append `-suffix` to a label, trimming the base so the result stays within 63 chars. */
function withSuffix(label: string, suffix: string): string {
  const base = label.slice(0, 63 - suffix.length - 1).replace(/-+$/, "");
  return `${base}-${suffix}`;
}

interface Desired {
  zone: string;
  name: string;
  type: DnsSyncRecordType;
  value: string;
  hostId: string;
}

/** A record the sync owns after this plan applies (the ledger is rebuilt from these). */
export type PublishedRecord = Desired;

/** The API-facing plan plus what the runner needs to rebuild the ledger. */
export interface ComputedSyncPlan extends DnsSyncPlan {
  published: PublishedRecord[];
}

export function computeSyncPlan(input: PlanInput): ComputedSyncPlan {
  const zone = lc(input.zone);
  const zones = input.zones.map(lc);
  const hosts: Record<string, DnsSyncHostOutcome> = {};
  const staleMs = input.staleDays * 86_400_000;

  // One host per IP (overlapping subnets): keep the most recently seen.
  const byIp = new Map<string, PlanHost>();
  for (const h of input.hosts) {
    const cur = byIp.get(h.ipAddress);
    if (!cur || (h.lastSeenAt?.getTime() ?? 0) > (cur.lastSeenAt?.getTime() ?? 0)) byIp.set(h.ipAddress, h);
  }

  // ---- names ----
  const candidates: Array<{ host: PlanHost; label: string; override: boolean }> = [];
  for (const h of byIp.values()) {
    const override = toDnsLabel(h.dnsName);
    const label = override ?? toDnsLabel(h.unifiName) ?? toDnsLabel(h.netbiosName);
    if (!label) {
      hosts[h.id] = { state: "unnamed", fqdn: null, message: "No override, UniFi or NetBIOS name" };
      continue;
    }
    if (!h.lastSeenAt || input.now.getTime() - h.lastSeenAt.getTime() > staleMs) {
      hosts[h.id] = { state: "stale", fqdn: null, message: `Not seen up in the last ${input.staleDays} days` };
      continue;
    }
    candidates.push({ host: h, label, override: override !== null });
  }

  // Collisions: an override wins its label, then the most recently seen host;
  // everyone else gets a "-<last octet>" suffix (then "-2", "-3"… if needed).
  candidates.sort(
    (a, b) =>
      Number(b.override) - Number(a.override) ||
      (b.host.lastSeenAt?.getTime() ?? 0) - (a.host.lastSeenAt?.getTime() ?? 0) ||
      a.host.ipAddress.localeCompare(b.host.ipAddress),
  );
  const used = new Set<string>();
  const desired: Desired[] = [];
  const missingReverse = new Set<string>();
  for (const c of candidates) {
    let label = c.label;
    if (used.has(label)) {
      const octet = c.host.ipAddress.split(".").pop() ?? "x";
      label = withSuffix(c.label, octet);
      for (let n = 2; used.has(label); n++) label = withSuffix(c.label, `${octet}-${n}`);
    }
    used.add(label);
    const fqdn = `${label}.${zone}`;
    hosts[c.host.id] = { state: "ok", fqdn, message: label !== c.label ? `Renamed from ${c.label} (name already taken)` : null };
    desired.push({ zone, name: fqdn, type: "A", value: c.host.ipAddress, hostId: c.host.id });
    if (input.ptr) {
      const rev = ptrName(c.host.ipAddress);
      const rz = reverseZoneFor(rev, zones);
      if (rz) {
        desired.push({ zone: rz, name: rev, type: "PTR", value: fqdn, hostId: c.host.id });
      } else {
        const o = c.host.ipAddress.split(".");
        missingReverse.add(`${o[2]}.${o[1]}.${o[0]}.in-addr.arpa`);
        hosts[c.host.id] = { ...hosts[c.host.id]!, message: "No reverse zone for its PTR record" };
      }
    }
  }

  // ---- diff ----
  const byKey = new Map<string, ExistingRecord[]>();
  const byName = new Map<string, ExistingRecord[]>();
  for (const r of input.existing) {
    const k = recordKey(r.zone, r.name, r.type);
    byKey.set(k, [...(byKey.get(k) ?? []), r]);
    const nk = `${lc(r.zone)}|${lc(r.name)}`;
    byName.set(nk, [...(byName.get(nk) ?? []), r]);
  }

  const actions: DnsSyncAction[] = [];
  const conflicts: DnsSyncConflict[] = [];
  const desiredKeys = new Set<string>();
  const published: PublishedRecord[] = [];
  // Hosts whose A record is blocked: their PTR would point at a name that
  // resolves somewhere else, so it's skipped too (and any old one removed).
  const aBlocked = new Set<string>();
  let unchanged = 0;
  const act = (a: Omit<DnsSyncAction, "ttl"> & { ttl?: number }): void => {
    actions.push({ ttl: input.ttl, ...a });
  };

  for (const d of desired) {
    if (d.type === "PTR" && aBlocked.has(d.hostId)) continue;
    const k = recordKey(d.zone, d.name, d.type);
    desiredKeys.add(k);
    const atKey = byKey.get(k) ?? [];
    const ours = atKey.filter(isManaged);
    // A hand-made record of the same type is in the way; for A records a
    // CNAME at the name is too (a CNAME can't share its name).
    const others = atKey.filter((r) => !isManaged(r));
    if (d.type === "A") {
      others.push(
        ...(byName.get(`${lc(d.zone)}|${lc(d.name)}`) ?? []).filter((r) => r.type === "CNAME" && !isManaged(r)),
      );
    }
    if (others.length > 0) {
      if (d.type === "A") aBlocked.add(d.hostId);
      conflicts.push({
        zone: d.zone,
        name: d.name,
        type: d.type,
        value: d.value,
        ipamHostId: d.hostId,
        existing: others.map((r) => `${r.type} ${r.value}`).join(", "),
      });
      hosts[d.hostId] = {
        ...hosts[d.hostId]!,
        state: "conflict",
        message: `${d.type === "A" ? d.name : `PTR ${d.name}`} is already used by a hand-made record`,
      };
      continue;
    }
    published.push(d);
    const exact = ours.find((r) => lc(r.value) === lc(d.value));
    const extras = ours.filter((r) => r !== exact);
    if (exact) {
      if (exact.ttl !== input.ttl) {
        act({ op: "update", zone: d.zone, name: d.name, type: d.type, value: d.value, fromValue: exact.value, ipamHostId: d.hostId, reason: `TTL ${exact.ttl} -> ${input.ttl}` });
      } else {
        unchanged++;
      }
    } else if (extras.length > 0) {
      const from = extras.shift()!;
      act({
        op: "update",
        zone: d.zone,
        name: d.name,
        type: d.type,
        value: d.value,
        fromValue: from.value,
        ipamHostId: d.hostId,
        reason: d.type === "A" ? "Address changed" : "Host name changed",
      });
    } else {
      act({ op: "add", zone: d.zone, name: d.name, type: d.type, value: d.value, fromValue: null, ipamHostId: d.hostId, reason: "New host" });
    }
    for (const r of extras) {
      act({ op: "remove", zone: d.zone, name: d.name, type: d.type, value: r.value, fromValue: null, ttl: r.ttl, ipamHostId: d.hostId, reason: "Duplicate synced record" });
    }
  }

  // Managed records nobody wants any more.
  let managedCount = 0;
  for (const r of input.existing) {
    if (!isManaged(r)) continue;
    managedCount++;
    const k = recordKey(r.zone, r.name, r.type);
    if (desiredKeys.has(k)) continue;
    if (r.type !== "A" && r.type !== "PTR") continue;
    const hostId = input.ledger.get(k) ?? null;
    const outcome = hostId ? hosts[hostId] : undefined;
    const reason =
      outcome?.state === "stale"
        ? `Host not seen for ${input.staleDays}+ days`
        : outcome?.state === "unnamed"
          ? "Host has no name any more"
          : outcome?.state === "ok" || outcome?.state === "conflict"
            ? "Host renamed"
            : "Host no longer published";
    act({ op: "remove", zone: lc(r.zone), name: lc(r.name), type: r.type, value: r.value, fromValue: null, ttl: r.ttl, ipamHostId: hostId, reason });
  }

  const removals = actions.filter((a) => a.op === "remove").length;
  const blocked =
    removals > SAFETY_MAX_REMOVALS ||
    (removals > SAFETY_SHARE_FLOOR && removals > managedCount * SAFETY_MAX_SHARE)
      ? `This run would remove ${removals} of ${managedCount} synced records. Check IPAM (a wiped subnet or a failed scan looks like this) and confirm to apply anyway.`
      : null;

  return {
    enabled: input.enabled,
    zone,
    ptr: input.ptr,
    ttl: input.ttl,
    actions,
    conflicts,
    missingReverseZones: [...missingReverse].sort(),
    hosts,
    managedCount,
    unchanged,
    blocked,
    published,
  };
}
