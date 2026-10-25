"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Images, Printer } from "lucide-react";
import type { PortSheet, PortSheetRow } from "@church/shared";
import { DataTable, type Column } from "@/components/data-table";
import { SwitchFaceplate } from "@/components/switch-faceplate";
import { PortViewToggle, usePortView } from "@/components/port-view-toggle";
import { SwitchViewLine } from "@/components/switch-view-line";
import { ProfilePictures } from "@/components/device-picture";
import { resolveSwitchView } from "@/lib/faceplates/custom";
import { useSwitchModels } from "@/lib/use-switch-models";
import { useRealtimeRoom } from "@/lib/use-realtime";
import { usePoll } from "@/lib/use-poll";
import {
  clientsByPort,
  portDescription,
  sortedPorts,
  unifiFaceItems,
  unifiPoeText,
  unifiPortState,
  type UnifiPort,
  type UnifiWiredClient,
} from "@/lib/unifi-ports";
import { useCanWrite } from "../../../network-cisco/cisco-ui";
import { DeviceStatus, formatUptime } from "../../network-client";
import { UnifiPictureDialog, type PictureDevice } from "../../unifi-picture-dialog";

interface UDevice {
  name?: string;
  model?: string;
  ip?: string;
  mac?: string;
  state?: number;
  type?: string;
  num_sta?: number;
  uptime?: number;
  port_table?: UnifiPort[];
  switchModelId?: string | null;
  switchViewOff?: boolean;
}

type Row = UnifiPort & { port_idx: number };

/**
 * One UniFi device: its picture with every port on it (the device profile chosen for it, else the one its model text
 * matches), or the ports as a list. Read-only: what each port carries comes from the controller's port profiles (the same
 * read the printable port sheet makes), and the client on a port from the controller's client list.
 */
export default function UnifiDevicePage() {
  const { mac: rawMac } = useParams<{ mac: string }>();
  const mac = decodeURIComponent(rawMac).toLowerCase();
  const canWrite = useCanWrite();
  const { models } = useSwitchModels();
  const [view, setView] = usePortView();
  const [device, setDevice] = useState<UDevice | null>(null);
  const [clients, setClients] = useState<UnifiWiredClient[]>([]);
  const [sheetRows, setSheetRows] = useState<Map<string, PortSheetRow>>(new Map());
  const [state, setState] = useState<"loading" | "ok" | "missing" | "error">("loading");
  const [picturing, setPicturing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [d, c] = await Promise.all([
        fetch("/api/unifi/devices", { credentials: "same-origin", cache: "no-store" }),
        fetch("/api/unifi/clients", { credentials: "same-origin", cache: "no-store" }),
      ]);
      if (!d.ok) return setState("error");
      const found = ((await d.json()) as UDevice[]).find((x) => (x.mac ?? "").toLowerCase() === mac) ?? null;
      setDevice(found);
      setState(found ? "ok" : "missing");
      if (c.ok) setClients((await c.json()) as UnifiWiredClient[]);
    } catch {
      setState("error");
    }
  }, [mac]);

  // VLANs and networks per port, as the printable sheet works them out. Only a device with ports has a sheet.
  const hasPorts = (device?.port_table?.length ?? 0) > 0;
  useEffect(() => {
    if (!hasPorts) return;
    let cancelled = false;
    fetch(`/api/port-sheets/unifi/${encodeURIComponent(mac)}`, { credentials: "same-origin", cache: "no-store" })
      .then(async (r) => (r.ok ? ((await r.json()) as PortSheet) : null))
      .then((sheet) => {
        if (!cancelled && sheet) setSheetRows(new Map(sheet.ports.map((p) => [p.port, p])));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [mac, hasPorts]);

  const onSnapshot = useCallback(
    (payload: unknown) => {
      const s = payload as { devices?: UDevice[]; clients?: UnifiWiredClient[] };
      if (Array.isArray(s.devices)) {
        const found = s.devices.find((x) => (x.mac ?? "").toLowerCase() === mac);
        if (found) setDevice(found);
      }
      if (Array.isArray(s.clients)) setClients(s.clients);
    },
    [mac],
  );
  const { connected } = useRealtimeRoom("network", { "network:snapshot": onSnapshot }, () => void load());
  useEffect(() => {
    void load();
  }, [load]);
  usePoll(() => load(), 30_000, { enabled: !connected, immediate: false });

  if (state === "loading") return <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>;
  if (state !== "ok" || !device) {
    return (
      <div className="space-y-3">
        <BackLink />
        <p className="text-sm">
          {state === "missing"
            ? "The UniFi controller does not list this device (it may have been removed or the address is wrong)."
            : "The UniFi controller could not be read just now."}
        </p>
      </div>
    );
  }

  const name = device.name?.trim() || mac;
  const ports = sortedPorts(device.port_table);
  const onPort = clientsByPort(clients, mac);
  const switchView = resolveSwitchView(models ?? [], { model: device.model, switchModelId: device.switchModelId, switchViewOff: device.switchViewOff });
  const layout = switchView.layout;
  const showFaceplate = view === "switch" && layout !== null && ports.length > 0;
  const toggle = layout && ports.length > 0 ? <PortViewToggle value={view} onChange={setView} /> : null;
  const pictureDevice: PictureDevice = { mac, name, model: device.model ?? null, switchModelId: device.switchModelId, switchViewOff: device.switchViewOff };
  const upCount = ports.filter((p) => p.enable !== false && p.up).length;
  const poeWatts = ports.reduce((sum, p) => sum + (unifiPoeText(p) ? Number(p.poe_power) : 0), 0);

  const columns: Column<Row>[] = [
    { key: "port", label: "Port", render: (p) => <span className="font-mono text-xs">{p.port_idx}</span>, sortValue: (p) => p.port_idx },
    { key: "description", label: "Description", render: (p) => portDescription(p) || <span className="text-slate-500 dark:text-slate-400">—</span>, sortValue: (p) => portDescription(p) },
    { key: "link", label: "Link", render: (p) => <span className="text-xs">{unifiPortState(p).text}</span>, sortValue: (p) => unifiPortState(p).text },
    { key: "network", label: "Network", render: (p) => <span className="text-xs">{sheetRows.get(String(p.port_idx))?.vlan ?? "—"}</span>, sortValue: (p) => sheetRows.get(String(p.port_idx))?.vlan ?? "" },
    { key: "poe", label: "PoE", render: (p) => <span className="text-xs">{unifiPoeText(p)?.replace("PoE, ", "") ?? "—"}</span>, sortValue: (p) => Number(unifiPoeText(p) ? p.poe_power : 0) },
    { key: "client", label: "Connected", render: (p) => <span className="text-xs">{clientText(onPort.get(p.port_idx))}</span>, sortValue: (p) => clientText(onPort.get(p.port_idx)) },
  ];

  return (
    <div className="space-y-4">
      <BackLink />

      <div className="flex flex-wrap items-center gap-3">
        <DeviceStatus state={device.state} />
        <h2 className="text-lg font-semibold">{name}</h2>
        {device.ip ? <span className="font-mono text-xs text-slate-500 dark:text-slate-400">{device.ip}</span> : null}
        {device.model ? <span className="text-xs text-slate-500 dark:text-slate-400">{device.model}</span> : null}
        <span className="font-mono text-xs text-slate-500 dark:text-slate-400">{mac}</span>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          up {formatUptime(device.uptime)}, {device.num_sta ?? 0} clients
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {ports.length > 0 ? (
            <Link
              href={`/print/unifi/${encodeURIComponent(mac)}`}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              <Printer className="h-4 w-4" aria-hidden /> Printable page
            </Link>
          ) : null}
          {canWrite && models ? (
            <button
              type="button"
              onClick={() => setPicturing(true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              <Images className="h-4 w-4" aria-hidden /> Picture
            </button>
          ) : null}
        </div>
      </div>

      {models !== null ? <SwitchViewLine view={switchView} deviceModel={device.model ?? null} canWrite={canWrite} /> : null}

      {ports.length === 0 ? (
        <>
          <p className="text-sm text-slate-500 dark:text-slate-400">This device has no switch ports to show (an access point or a device without a port table).</p>
          {switchView.model ? <ProfilePictures model={switchView.model} deviceName={name} /> : null}
        </>
      ) : showFaceplate && layout ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {upCount} of {ports.length} ports up.{poeWatts > 0 ? ` ${poeWatts.toFixed(1)} W of PoE in use.` : ""} Hover a port for its details.
            </span>
            {toggle}
          </div>
          <SwitchFaceplate
            layout={layout}
            items={unifiFaceItems(ports, layout)}
            renderDetails={(id) => {
              const p = ports.find((x) => String(x.port_idx) === id);
              return p ? <PortDetails p={p} row={sheetRows.get(id)} clients={onPort.get(p.port_idx)} /> : null;
            }}
          />
        </div>
      ) : (
        <DataTable
          rightSlot={toggle}
          rowsSelector="footer"
          rows={ports}
          columns={columns}
          getKey={(p) => String(p.port_idx)}
          initialSort={{ key: "port", dir: "asc" }}
          filterPlaceholder="Filter ports…"
          emptyText="No ports."
        />
      )}

      {picturing && models ? (
        <UnifiPictureDialog
          device={pictureDevice}
          models={models}
          onClose={() => setPicturing(false)}
          onSaved={() => {
            setPicturing(false);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

function BackLink() {
  return (
    <Link href="/monitoring/network" className="inline-flex items-center gap-1 text-sm text-brand-600 hover:underline dark:text-brand-400">
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> All UniFi devices
    </Link>
  );
}

function clientText(list: UnifiWiredClient[] | undefined): string {
  if (!list || list.length === 0) return "—";
  const first = list[0]!;
  const label = first.name || first.hostname || first.ip || first.mac || "a client";
  return list.length > 1 ? `${label} +${list.length - 1} more` : label;
}

/** The popover for one port: what it is, how it is linked, what it carries and what is plugged in. Nothing here changes it. */
function PortDetails({ p, row, clients }: { p: Row; row: PortSheetRow | undefined; clients: UnifiWiredClient[] | undefined }) {
  const description = portDescription(p);
  const poe = unifiPoeText(p);
  return (
    <div className="space-y-1.5 text-sm">
      <p className="font-mono font-semibold">Port {p.port_idx}</p>
      {description ? <p>{description}</p> : null}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        <dt className="text-slate-500 dark:text-slate-400">Link</dt>
        <dd>{unifiPortState(p).text}{p.is_uplink ? " (uplink)" : ""}</dd>
        {row ? (
          <>
            <dt className="text-slate-500 dark:text-slate-400">Network</dt>
            <dd>{row.vlan}</dd>
            {row.subnet && row.subnet !== "-" ? (
              <>
                <dt className="text-slate-500 dark:text-slate-400">Subnet</dt>
                <dd className="font-mono">{row.subnet}</dd>
              </>
            ) : null}
          </>
        ) : null}
        {poe ? (
          <>
            <dt className="text-slate-500 dark:text-slate-400">PoE</dt>
            <dd>{poe.replace("PoE, ", "")}{p.poe_class ? `, class ${p.poe_class}` : ""}</dd>
          </>
        ) : null}
        {p.media ? (
          <>
            <dt className="text-slate-500 dark:text-slate-400">Media</dt>
            <dd>{p.media}</dd>
          </>
        ) : null}
      </dl>
      {clients && clients.length > 0 ? (
        <div className="text-xs">
          <p className="text-slate-500 dark:text-slate-400">Connected</p>
          <ul className="space-y-0.5">
            {clients.slice(0, 5).map((c) => (
              <li key={c.mac ?? c.ip}>
                {c.name || c.hostname || "Unnamed"} {c.ip ? <span className="font-mono">{c.ip}</span> : null}{" "}
                <span className="font-mono text-slate-500 dark:text-slate-400">{c.mac}</span>
              </li>
            ))}
            {clients.length > 5 ? <li>and {clients.length - 5} more</li> : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
