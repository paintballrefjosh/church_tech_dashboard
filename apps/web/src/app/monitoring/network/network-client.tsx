"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CircleCheck, CircleHelp, RefreshCw } from "lucide-react";
import { useRealtimeRoom } from "@/lib/use-realtime";
import { DataTable, type Column } from "@/components/data-table";
import { MONITORING_HEALTH_REFRESH } from "../section-tabs";

interface Health {
  configured: boolean;
  reachable: boolean;
  error: string | null;
}

// UniFi rows are deeply nested and vary between firmware versions; we render
// only the fields we know about and let unknown ones slide.
interface UDevice {
  name?: string;
  model?: string;
  ip?: string;
  mac?: string;
  state?: number;
  type?: string;
  num_sta?: number;
  uptime?: number;
  // Server-annotated: operator has acknowledged this device's current outage,
  // so it's suppressed from the Network tab problem badge until it recovers.
  acked?: boolean;
}
interface UClient {
  name?: string;
  hostname?: string;
  ip?: string;
  mac?: string;
  network?: string;
  oui?: string;
  rx_bytes?: number;
  tx_bytes?: number;
  signal?: number;
  is_wired?: boolean;
}

export function NetworkClient() {
  const [tab, setTab] = useState<"devices" | "clients">("devices");
  const [health, setHealth] = useState<Health | null>(null);
  const [devices, setDevices] = useState<UDevice[]>([]);
  const [clients, setClients] = useState<UClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [ackError, setAckError] = useState<string | null>(null);

  const load = useCallback(async (initial = false) => {
    if (initial) setLoading(true);
    else setRefreshing(true);
    try {
      const [h, d, c] = await Promise.all([
        fetch("/api/unifi/health", { credentials: "same-origin", cache: "no-store" }),
        fetch("/api/unifi/devices", { credentials: "same-origin", cache: "no-store" }),
        fetch("/api/unifi/clients", { credentials: "same-origin", cache: "no-store" }),
      ]);
      if (h.ok) setHealth((await h.json()) as Health);
      if (d.ok) setDevices((await d.json()) as UDevice[]);
      if (c.ok) setClients((await c.json()) as UClient[]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // The server polls the controller and pushes a full snapshot to the
  // `network` room; consume it directly so the browser reflects each poll as
  // it lands. First paint + reconnect resync use the REST load().
  const onSnapshot = useCallback((payload: unknown) => {
    const s = payload as { health?: Health; devices?: UDevice[]; clients?: UClient[] };
    if (s.health) setHealth(s.health);
    if (Array.isArray(s.devices)) setDevices(s.devices);
    if (Array.isArray(s.clients)) setClients(s.clients);
    setLoading(false);
    setRefreshing(false);
  }, []);

  // Acknowledge / clear an offline device. Optimistic; reverts on failure.
  const toggleAck = useCallback(
    async (mac: string, currentlyAcked: boolean) => {
      setAckError(null);
      setDevices((prev) => prev.map((d) => (d.mac === mac ? { ...d, acked: !currentlyAcked } : d)));
      try {
        const r = await fetch(`/api/unifi/devices/${encodeURIComponent(mac)}/ack`, {
          method: currentlyAcked ? "DELETE" : "POST",
          credentials: "same-origin",
        });
        if (!r.ok) {
          setDevices((prev) => prev.map((d) => (d.mac === mac ? { ...d, acked: currentlyAcked } : d)));
          setAckError(
            r.status === 403
              ? "You don't have permission to acknowledge devices."
              : `Couldn't update acknowledgement (${r.status}).`,
          );
        } else {
          void load(false);
          // Nudge the tab badges to re-fetch now instead of waiting for their poll.
          window.dispatchEvent(new Event(MONITORING_HEALTH_REFRESH));
        }
      } catch {
        setDevices((prev) => prev.map((d) => (d.mac === mac ? { ...d, acked: currentlyAcked } : d)));
        setAckError("Couldn't update acknowledgement — network error.");
      }
    },
    [load],
  );

  const { connected } = useRealtimeRoom(
    "network",
    { "network:snapshot": onSnapshot },
    () => void load(false),
  );

  // First paint immediately; a slow poll backs us up only if the socket drops.
  useEffect(() => {
    void load(true);
  }, [load]);

  useEffect(() => {
    if (connected) return;
    const t = setInterval(() => void load(false), 30_000);
    return () => clearInterval(t);
  }, [connected, load]);

  if (loading) return <p className="text-sm text-slate-500">Loading…</p>;

  if (health && !health.configured) {
    return (
      <p className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300">
        UniFi isn&apos;t configured. Set <code className="mx-0.5">unifi.controller_url</code> and{" "}
        <code className="mx-0.5">unifi.api_key</code> in{" "}
        <a className="underline" href="/admin/settings/monitoring">
          Settings
        </a>{" "}
        to enable.
      </p>
    );
  }
  if (health && !health.reachable) {
    return (
      <p className="rounded-md border border-rose-300 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300">
        Controller unreachable: {health.error ?? "unknown error"}. Double-check the URL, API key
        and that TLS-verification matches your cert.
      </p>
    );
  }

  return (
    <div>
      <div className="mb-4 flex items-center gap-2 border-b border-slate-300 text-sm dark:border-slate-800">
        <TabButton active={tab === "devices"} onClick={() => setTab("devices")}>
          Devices ({devices.length})
        </TabButton>
        <TabButton active={tab === "clients"} onClick={() => setTab("clients")}>
          Clients ({clients.length})
        </TabButton>
        <button
          type="button"
          onClick={() => void load(false)}
          disabled={refreshing}
          aria-label="Refresh"
          className="ml-auto mb-[-1px] inline-flex items-center gap-1 px-2 py-1 text-xs text-slate-500 hover:text-slate-900 disabled:opacity-50 dark:hover:text-white"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} aria-hidden />
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {ackError ? (
        <p className="mb-2 text-xs text-rose-600 dark:text-rose-400">{ackError}</p>
      ) : null}

      {tab === "devices" ? (
        <DevicesTable items={devices} onToggleAck={toggleAck} />
      ) : (
        <ClientsTable items={clients} />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`mb-[-1px] border-b-2 px-3 py-2 ${
        active
          ? "border-brand-600 text-brand-700 dark:text-brand-300"
          : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
      }`}
    >
      {children}
    </button>
  );
}

function DevicesTable({
  items,
  onToggleAck,
}: {
  items: UDevice[];
  onToggleAck: (mac: string, currentlyAcked: boolean) => void;
}) {
  const columns: Column<UDevice>[] = [
    {
      key: "status",
      label: "",
      render: (d) => <DeviceStatus state={d.state} />,
      // Sort surfaces disconnected first when descending.
      sortValue: (d) => (d.state === 1 ? 0 : d.state === 0 ? 2 : 1),
    },
    {
      key: "name",
      label: "Name",
      render: (d) => (
        <span className="flex items-center gap-2">
          <span className="font-medium">{d.name ?? "—"}</span>
          {d.acked ? (
            <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-medium uppercase text-slate-600 dark:bg-slate-700 dark:text-slate-300">
              acked
            </span>
          ) : null}
        </span>
      ),
      sortValue: (d) => d.name ?? "",
    },
    {
      key: "model",
      label: "Model",
      render: (d) => <span className="text-xs text-slate-600 dark:text-slate-400">{d.model ?? d.type ?? "—"}</span>,
      sortValue: (d) => d.model ?? d.type ?? "",
    },
    { key: "ip", label: "IP", render: (d) => <span className="font-mono text-xs">{d.ip ?? "—"}</span>, sortValue: (d) => d.ip ?? "" },
    { key: "mac", label: "MAC", render: (d) => <span className="font-mono text-xs">{d.mac ?? "—"}</span>, sortValue: (d) => d.mac ?? "" },
    { key: "clients", label: "Clients", align: "right", render: (d) => <span>{d.num_sta ?? 0}</span>, sortValue: (d) => d.num_sta ?? 0 },
    {
      key: "uptime",
      label: "Uptime",
      align: "right",
      render: (d) => <span className="text-xs text-slate-500">{formatUptime(d.uptime)}</span>,
      sortValue: (d) => d.uptime ?? 0,
    },
    {
      key: "ack",
      label: "",
      align: "right",
      // Only offline devices can be acknowledged; online ones have nothing to
      // ack. Acking suppresses the device from the tab badge until it recovers.
      render: (d) => {
        if (d.state === 1 || !d.mac) return null;
        const mac = d.mac;
        return (
          <button
            type="button"
            onClick={() => onToggleAck(mac, !!d.acked)}
            className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            {d.acked ? "Clear ack" : "Ack"}
          </button>
        );
      },
    },
  ];
  return (
    <DataTable
      rows={items}
      columns={columns}
      getKey={(d) => d.mac ?? `${d.name ?? ""}-${d.ip ?? ""}`}
      initialSort={{ key: "name", dir: "asc" }}
      filterPlaceholder="Search devices by name, model, IP, MAC…"
      emptyText="No devices reported."
    />
  );
}

function ClientsTable({ items }: { items: UClient[] }) {
  const columns: Column<UClient>[] = [
    { key: "name", label: "Name", render: (c) => <span className="font-medium">{c.name ?? c.hostname ?? "—"}</span>, sortValue: (c) => c.name ?? c.hostname ?? "" },
    { key: "ip", label: "IP", render: (c) => <span className="font-mono text-xs">{c.ip ?? "—"}</span>, sortValue: (c) => c.ip ?? "" },
    { key: "mac", label: "MAC", render: (c) => <span className="font-mono text-xs">{c.mac ?? "—"}</span>, sortValue: (c) => c.mac ?? "" },
    { key: "network", label: "Network", render: (c) => <span className="text-xs">{c.network ?? "—"}</span>, sortValue: (c) => c.network ?? "" },
    {
      key: "conn",
      label: "Connection",
      render: (c) => <span className="text-xs">{c.is_wired ? "Wired" : `Wi-Fi${c.signal ? ` (${c.signal} dBm)` : ""}`}</span>,
      sortValue: (c) => (c.is_wired ? "Wired" : "Wi-Fi"),
    },
    {
      key: "traffic",
      label: "RX / TX",
      align: "right",
      render: (c) => (
        <span className="text-xs text-slate-500">
          {formatBytes(c.rx_bytes)} / {formatBytes(c.tx_bytes)}
        </span>
      ),
      sortValue: (c) => (c.rx_bytes ?? 0) + (c.tx_bytes ?? 0),
    },
  ];
  return (
    <DataTable
      rows={items}
      columns={columns}
      getKey={(c) => c.mac ?? `${c.ip ?? ""}-${c.name ?? ""}`}
      initialSort={{ key: "name", dir: "asc" }}
      filterPlaceholder="Search clients by name, IP, MAC, network…"
      emptyText="No clients reported."
    />
  );
}

function DeviceStatus({ state }: { state?: number }) {
  // UniFi state codes: 1 = connected, 0 = disconnected, others = pending / upgrading.
  if (state === 1)
    return <CircleCheck className="h-4 w-4 text-emerald-500" aria-label="Connected" />;
  if (state === 0)
    return <AlertTriangle className="h-4 w-4 text-rose-500" aria-label="Disconnected" />;
  return <CircleHelp className="h-4 w-4 text-slate-400" aria-label="Pending" />;
}

function formatUptime(secs?: number): string {
  if (!secs || secs <= 0) return "—";
  const d = Math.floor(secs / 86400);
  if (d > 0) return `${d}d`;
  const h = Math.floor(secs / 3600);
  if (h > 0) return `${h}h`;
  const m = Math.floor(secs / 60);
  return `${m}m`;
}

function formatBytes(b?: number): string {
  if (!b || b <= 0) return "0";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = b;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}
