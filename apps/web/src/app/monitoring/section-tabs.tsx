"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Activity, Server, Wifi, Network, Boxes, BatteryCharging } from "lucide-react";
import { MaintenanceControl } from "./maintenance-control";

/**
 * Secondary navigation for the Monitoring section. Services (uptime monitors),
 * Infrastructure (host/Docker/Proxmox), Network (UniFi), and Network (Cisco)
 * are all facets of the same `monitoring` module, so they share one tabbed
 * shell rather than living as separate top-level pages.
 *
 * Each tab carries a small badge counting problems in that area — amber for
 * degraded, red when anything is critical — so an operator can see at a glance
 * where something's wrong without opening each tab.
 */
/**
 * Window event a monitoring sub-page dispatches after a mutation that changes
 * its problem count, so the tab badges refresh immediately rather than on the
 * next 20s poll. Kept as a plain window event to avoid threading shared state
 * between the tabs bar and each independently-rendered page.
 */
export const MONITORING_HEALTH_REFRESH = "monitoring:health-refresh";

const TABS = [
  {
    key: "services",
    href: "/monitoring",
    label: "Services",
    Icon: Activity,
    match: (p: string) =>
      p === "/monitoring" ||
      (p.startsWith("/monitoring/") &&
        !p.startsWith("/monitoring/infra") &&
        !p.startsWith("/monitoring/network") &&
        !p.startsWith("/monitoring/ipam") &&
        !p.startsWith("/monitoring/ups")),
  },
  { key: "infra", href: "/monitoring/infra", label: "Infrastructure", Icon: Server, match: (p: string) => p.startsWith("/monitoring/infra") },
  {
    key: "unifi",
    href: "/monitoring/network",
    label: "Network (UniFi)",
    Icon: Wifi,
    match: (p: string) => p === "/monitoring/network" || p.startsWith("/monitoring/network/"),
  },
  {
    key: "cisco",
    href: "/monitoring/network-cisco",
    label: "Network (Cisco)",
    Icon: Network,
    match: (p: string) => p.startsWith("/monitoring/network-cisco"),
  },
  {
    key: "ipam",
    href: "/monitoring/ipam",
    label: "IPAM",
    Icon: Boxes,
    match: (p: string) => p.startsWith("/monitoring/ipam"),
  },
  {
    key: "ups",
    href: "/monitoring/ups",
    label: "UPS",
    Icon: BatteryCharging,
    match: (p: string) => p.startsWith("/monitoring/ups"),
  },
] as const;

interface Health {
  critical: number;
  degraded: number;
}
type HealthMap = Partial<Record<string, Health>>;

export function MonitoringTabs() {
  const pathname = usePathname();
  const [health, setHealth] = useState<HealthMap>({});

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const next = await loadHealth();
      if (!cancelled) setHealth(next);
    }
    void load();
    const t = setInterval(() => void load(), 20_000);
    // Let a tab's own page trigger an immediate badge refresh after a mutation
    // (e.g. acking a UniFi device) instead of waiting for the poll interval.
    const onRefresh = () => void load();
    window.addEventListener(MONITORING_HEALTH_REFRESH, onRefresh);
    return () => {
      cancelled = true;
      clearInterval(t);
      window.removeEventListener(MONITORING_HEALTH_REFRESH, onRefresh);
    };
  }, []);

  return (
    <div className="mb-6 flex flex-wrap items-center gap-1 border-b border-slate-300 text-sm dark:border-slate-800">
      {TABS.map((t) => {
        const active = t.match(pathname);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={`mb-[-1px] inline-flex items-center gap-1.5 border-b-2 px-3 py-2 ${
              active
                ? "border-brand-600 text-brand-700 dark:text-brand-300"
                : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
            }`}
          >
            <t.Icon className="h-4 w-4" aria-hidden />
            {t.label}
            <HealthBadge health={health[t.key]} />
          </Link>
        );
      })}
      {/* Monitoring on/off switch, right-aligned on the same row as the tabs. */}
      <MaintenanceControl />
    </div>
  );
}

function HealthBadge({ health }: { health?: Health }) {
  if (!health) return null;
  const total = health.critical + health.degraded;
  if (total === 0) return null;
  const critical = health.critical > 0;
  const title =
    health.critical > 0 && health.degraded > 0
      ? `${health.critical} critical, ${health.degraded} degraded`
      : health.critical > 0
        ? `${health.critical} critical`
        : `${health.degraded} degraded`;
  return (
    <span
      title={title}
      className={`ml-0.5 inline-flex h-[1.1rem] min-w-[1.1rem] items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none text-white ${
        critical ? "bg-rose-500" : "bg-amber-500"
      }`}
    >
      {total}
    </span>
  );
}

/** Poll each area's summary and reduce to {critical, degraded} counts. */
async function loadHealth(): Promise<HealthMap> {
  const out: HealthMap = {};
  const getJson = async (url: string): Promise<unknown | null> => {
    try {
      const r = await fetch(url, { credentials: "same-origin", cache: "no-store" });
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  };

  const [mon, infra, unifi, cisco, ipam, ups] = await Promise.all([
    getJson("/api/monitors/summary"),
    getJson("/api/infra/summary"),
    getJson("/api/unifi/summary"),
    getJson("/api/cisco/switches"),
    getJson("/api/ipam/summary"),
    getJson("/api/ups/summary"),
  ]);

  if (mon) {
    const s = mon as { down?: number; unknown?: number };
    out.services = { critical: s.down ?? 0, degraded: s.unknown ?? 0 };
  }
  if (infra) {
    const s = infra as { targets?: { down?: number; degraded?: number } };
    out.infra = { critical: s.targets?.down ?? 0, degraded: s.targets?.degraded ?? 0 };
  }
  if (unifi) {
    const s = unifi as {
      configured?: boolean;
      reachable?: boolean;
      devices?: { offline?: number; acked?: number };
    };
    if (s.configured) {
      // Controller unreachable OR any offline device = critical, minus devices
      // an operator has acknowledged (they re-count only if they recover and
      // then go offline again — the server clears the ack on recovery).
      const unackedOffline = Math.max(0, (s.devices?.offline ?? 0) - (s.devices?.acked ?? 0));
      out.unifi = {
        critical: (s.reachable === false ? 1 : 0) + unackedOffline,
        degraded: 0,
      };
    }
  }
  if (Array.isArray(cisco)) {
    let critical = 0;
    let degraded = 0;
    for (const sw of cisco as Array<{ reachable?: boolean; configDrift?: boolean; checkPortState?: boolean; portsDownEnabled?: number }>) {
      if (sw.reachable === false) critical++;
      else if (sw.configDrift || (sw.checkPortState && (sw.portsDownEnabled ?? 0) > 0)) degraded++;
    }
    out.cisco = { critical, degraded };
  }
  if (ipam) {
    // A subnet whose last sweep errored (e.g. truncated) reads as degraded.
    const s = ipam as { errored?: number };
    out.ipam = { critical: 0, degraded: s.errored ?? 0 };
  }
  if (ups) {
    const s = ups as { red?: number; yellow?: number };
    out.ups = { critical: s.red ?? 0, degraded: s.yellow ?? 0 };
  }
  return out;
}
