"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CircleCheck, CircleHelp, Printer, RefreshCw, Settings as SettingsIcon, Ticket } from "lucide-react";
import { useRealtimeRoom } from "@/lib/use-realtime";
import { DataTable, type Column } from "@/components/data-table";
import { clientTraffic } from "@/lib/unifi-traffic";
import { MONITORING_HEALTH_REFRESH } from "../section-tabs";
import { usePoll } from "@/lib/use-poll";
import { useSwitchModels } from "@/lib/use-switch-models";
import { useDeviceHoverPreview } from "./device-hover-preview";

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
  // A switch or gateway lists its ports here; an access point does not.
  port_table?: unknown[];
  // Server-annotated: operator has acknowledged this device's current outage,
  // so it's suppressed from the Network tab problem badge until it recovers.
  acked?: boolean;
  // Server-annotated: the picture choice made for this device (no row = automatic, matched on `model`).
  switchModelId?: string | null;
  switchViewOff?: boolean;
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
  "wired-rx_bytes"?: number;
  "wired-tx_bytes"?: number;
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

  usePoll(() => load(false), 30_000, { enabled: !connected, immediate: false });

  const actions = (
    <PageActions refreshing={refreshing} onRefresh={() => void load(false)} />
  );
  const viewSwitch = (
    <ViewSwitch value={tab} onChange={setTab} devices={devices.length} clients={clients.length} />
  );

  if (loading) return <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>;

  if (health && !health.configured) {
    return (
      <div className="space-y-3">
      <div className="flex justify-end">{actions}</div>
      <p className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300">
        UniFi isn&apos;t configured. Set <code className="mx-0.5">unifi.controller_url</code> and{" "}
        <code className="mx-0.5">unifi.api_key</code> in{" "}
        <a className="underline" href="/admin/settings/monitoring">
          Settings
        </a>{" "}
        to enable.
      </p>
      </div>
    );
  }
  if (health && !health.reachable) {
    return (
      <div className="space-y-3">
      <div className="flex justify-end">{actions}</div>
      <p className="rounded-md border border-rose-300 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300">
        Controller unreachable: {health.error ?? "unknown error"}. Double-check the URL, API key
        and that TLS-verification matches your cert.
      </p>
      </div>
    );
  }

  return (
    <div>
      {ackError ? (
        <p className="mb-2 text-xs text-rose-600 dark:text-rose-400">{ackError}</p>
      ) : null}

      {tab === "devices" ? (
        <DevicesTable items={devices} onToggleAck={toggleAck} leftSlot={viewSwitch} rightSlot={actions} />
      ) : (
        <ClientsTable items={clients} leftSlot={viewSwitch} rightSlot={actions} />
      )}

    </div>
  );
}

const SWITCH_BASE = "inline-flex items-center px-3 py-1.5 text-sm";
const SWITCH_ON = "bg-brand-600 text-white";
const SWITCH_OFF = "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800";

/** "Devices | Clients": which list the table shows, with how many of each. */
function ViewSwitch({
  value,
  onChange,
  devices,
  clients,
}: {
  value: "devices" | "clients";
  onChange: (v: "devices" | "clients") => void;
  devices: number;
  clients: number;
}) {
  return (
    <div role="group" aria-label="Show" className="inline-flex overflow-hidden rounded-md border border-slate-300 dark:border-slate-700">
      <button type="button" aria-pressed={value === "devices"} onClick={() => onChange("devices")} className={`${SWITCH_BASE} ${value === "devices" ? SWITCH_ON : SWITCH_OFF}`}>
        Devices ({devices})
      </button>
      <button type="button" aria-pressed={value === "clients"} onClick={() => onChange("clients")} className={`${SWITCH_BASE} border-l border-slate-300 dark:border-slate-700 ${value === "clients" ? SWITCH_ON : SWITCH_OFF}`}>
        Clients ({clients})
      </button>
    </div>
  );
}

const ACTION_CLS =
  "inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900 disabled:opacity-50 dark:text-slate-300 dark:hover:text-white";

/** Refresh and the links that belong to the whole page, at the right of the table's toolbar. */
function PageActions({ refreshing, onRefresh }: { refreshing: boolean; onRefresh: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-4">
      <button type="button" onClick={onRefresh} disabled={refreshing} className={ACTION_CLS}>
        <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} aria-hidden />
        {refreshing ? "Refreshing…" : "Refresh"}
      </button>
      <Link href="/monitoring/network/vouchers" className={ACTION_CLS}>
        <Ticket className="h-4 w-4" aria-hidden /> Guest vouchers
      </Link>
      <Link href="/admin/settings/monitoring" className={ACTION_CLS}>
        <SettingsIcon className="h-4 w-4" aria-hidden /> UniFi config
      </Link>
    </div>
  );
}

function DevicesTable({
  items,
  onToggleAck,
  leftSlot,
  rightSlot,
}: {
  items: UDevice[];
  onToggleAck: (mac: string, currentlyAcked: boolean) => void;
  leftSlot: React.ReactNode;
  rightSlot: React.ReactNode;
}) {
  const { models } = useSwitchModels();
  const { rowProps, card } = useDeviceHoverPreview(models);
  const columns: Column<UDevice>[] = [
    {
      key: "status",
      label: "",
      srLabel: "Status",
      render: (d) => <DeviceStatus state={d.state} />,
      // Sort surfaces disconnected first when descending.
      sortValue: (d) => (d.state === 1 ? 0 : d.state === 0 ? 2 : 1),
    },
    {
      key: "name",
      label: "Name",
      render: (d) => (
        <span className="flex items-center gap-2">
          {d.mac ? (
            <Link href={`/monitoring/network/devices/${encodeURIComponent(d.mac.toLowerCase())}`} className="font-medium text-brand-600 hover:underline dark:text-brand-400">
              {d.name ?? d.mac}
            </Link>
          ) : (
            <span className="font-medium">{d.name ?? "—"}</span>
          )}
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
      render: (d) => <span className="text-xs text-slate-500 dark:text-slate-400">{formatUptime(d.uptime)}</span>,
      sortValue: (d) => d.uptime ?? 0,
    },
    {
      key: "print",
      label: "",
      srLabel: "Printable port sheet",
      align: "right",
      // Only a device with a port table has ports to list.
      render: (d) =>
        d.mac && Array.isArray(d.port_table) && d.port_table.length > 0 ? (
          <Link
            href={`/print/unifi/${encodeURIComponent(d.mac)}`}
            aria-label={`Printable port sheet for ${d.name ?? d.mac}`}
            className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            <Printer className="h-3.5 w-3.5" aria-hidden /> Print ports
          </Link>
        ) : null,
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
    <>
      <DataTable
        rows={items}
        columns={columns}
        getKey={(d) => d.mac ?? `${d.name ?? ""}-${d.ip ?? ""}`}
        initialSort={{ key: "name", dir: "asc" }}
        filterPlaceholder="Search devices…"
        emptyText="No devices reported."
        leftSlot={leftSlot}
        rightSlot={rightSlot}
        rowsSelector="footer"
        rowProps={rowProps}
      />
      {card}
    </>
  );
}

function ClientsTable({ items, leftSlot, rightSlot }: { items: UClient[]; leftSlot: React.ReactNode; rightSlot: React.ReactNode }) {
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
      label: "Down / Up",
      align: "right",
      render: (c) => {
        const t = clientTraffic(c);
        return (
          <span className="text-xs text-slate-500 dark:text-slate-400" title="What the client downloaded / uploaded">
            {formatBytes(t.down)} / {formatBytes(t.up)}
          </span>
        );
      },
      sortValue: (c) => {
        const t = clientTraffic(c);
        return (t.down ?? 0) + (t.up ?? 0);
      },
    },
  ];
  return (
    <DataTable
      rows={items}
      columns={columns}
      getKey={(c) => c.mac ?? `${c.ip ?? ""}-${c.name ?? ""}`}
      initialSort={{ key: "name", dir: "asc" }}
      filterPlaceholder="Search clients…"
      emptyText="No clients reported."
      leftSlot={leftSlot}
      rightSlot={rightSlot}
      rowsSelector="footer"
    />
  );
}

export function DeviceStatus({ state }: { state?: number }) {
  // UniFi state codes: 1 = connected, 0 = disconnected, others = pending / upgrading.
  if (state === 1)
    return <CircleCheck className="h-4 w-4 text-emerald-700 dark:text-emerald-400" aria-label="Connected" />;
  if (state === 0)
    return <AlertTriangle className="h-4 w-4 text-rose-600 dark:text-rose-400" aria-label="Disconnected" />;
  return <CircleHelp className="h-4 w-4 text-slate-500 dark:text-slate-400" aria-label="Pending" />;
}

export function formatUptime(secs?: number): string {
  if (!secs || secs <= 0) return "—";
  const d = Math.floor(secs / 86400);
  if (d > 0) return `${d}d`;
  const h = Math.floor(secs / 3600);
  if (h > 0) return `${h}h`;
  const m = Math.floor(secs / 60);
  return `${m}m`;
}

function formatBytes(b: number | null): string {
  if (b === null) return "\u2014";
  if (b <= 0) return "0";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = b;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}
