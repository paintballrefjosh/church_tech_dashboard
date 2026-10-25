"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Plus, Pencil, Trash2, Power, PowerOff, DownloadCloud, Loader2, Printer, Zap } from "lucide-react";
import {
  CISCO_DUPLEX_CHOICES,
  CISCO_SPEED_CHOICES,
  normaliseDuplex,
  normaliseSpeed,
  speedLabel,
  type CiscoSwitch,
  type CiscoSwitchVlan,
  type CiscoPortRow,
} from "@church/shared";
import { TrunkVlanField, VlanSelect } from "../../vlan-fields";
import { useCanWrite, StatusPill, computeStatus, PendingLine, StatusLine, Modal, Field, inputCls } from "../../cisco-ui";
import { DataTable, type Column } from "@/components/data-table";
import { PortViewToggle, usePortView } from "@/components/port-view-toggle";
import { SwitchFaceplate, type FaceItem } from "@/components/switch-faceplate";
import { slotForPort, type FaceplateLayout } from "@/lib/faceplates/layouts";
import { resolveSwitchView } from "@/lib/faceplates/custom";
import { faceState } from "@/lib/faceplates/face-state";
import { poeInUse, poeProviding, poeRows, poeSummary } from "@/lib/poe";
import { SwitchViewLine } from "@/components/switch-view-line";
import { GoneNotice } from "@/components/gone-notice";
import { useSwitchModels } from "@/lib/use-switch-models";
import { SwitchFormModal, formFromSwitch, type SwitchFormState } from "../../switch-form";

/** The standard speeds, plus the port's own value when it is something else (a typo stays visible, not hidden). */
function speedOptions(current: string): Array<{ value: string; label: string }> {
  const v = normaliseSpeed(current);
  return CISCO_SPEED_CHOICES.some((c) => c.value === v) ? [...CISCO_SPEED_CHOICES] : [...CISCO_SPEED_CHOICES, { value: v, label: v }];
}

interface PortForm {
  id: string | null;
  portId: string;
  description: string;
  adminEnabled: boolean;
  speed: string;
  duplex: string;
  mode: "access" | "trunk";
  hasSwitchport: boolean;
  accessVlan: number;
  trunkNativeVlan: number;
  trunkAllowedVlans: string;
}
const EMPTY: PortForm = {
  id: null,
  portId: "",
  description: "",
  adminEnabled: true,
  speed: "auto",
  duplex: "auto",
  mode: "access",
  hasSwitchport: true,
  accessVlan: 1,
  trunkNativeVlan: 1,
  trunkAllowedVlans: "1-4094",
};

function portToForm(p: CiscoPortRow): PortForm {
  return {
    id: p.id,
    portId: p.portId,
    description: p.description,
    adminEnabled: p.adminEnabled,
    speed: p.speed,
    duplex: p.duplex,
    mode: p.mode === "trunk" ? "trunk" : "access",
    hasSwitchport: p.hasSwitchport,
    accessVlan: p.accessVlan,
    trunkNativeVlan: p.trunkNativeVlan,
    trunkAllowedVlans: p.trunkAllowedVlans,
  };
}

function PortDetails({
  p,
  canWrite,
  busy,
  pushing,
  onToggle,
  onEdit,
  onDelete,
}: {
  p: CiscoPortRow;
  canWrite: boolean;
  busy: boolean;
  pushing: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const fs = faceState(p);
  const rows: Array<[string, string]> = [
    ["Description", p.description || "—"],
    ["Admin", p.adminEnabled ? "enabled" : "shut"],
    ["Live", p.operStatus ?? "—"],
    ...poeRows(p.poe),
    ["Mode", p.hasSwitchport ? p.mode : "routed"],
    [p.mode === "trunk" ? "Native / allowed" : "VLAN", p.mode === "trunk" ? `${p.trunkNativeVlan} · ${p.trunkAllowedVlans}` : p.hasSwitchport ? String(p.accessVlan) : "—"],
    ["Speed / duplex", `${speedLabel(p.speed)} · ${normaliseDuplex(p.duplex)}`],
    ["Neighbor", p.neighborHostname ? `${p.neighborHostname}${p.neighborPort ? ` (${p.neighborPort})` : ""}` : "—"],
  ];
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1 font-mono text-sm font-semibold">
          {p.portId}
          {poeProviding(p.poe) ? <Zap aria-hidden className="h-3.5 w-3.5 text-amber-500" fill="currentColor" /> : null}
        </span>
        <span className="text-xs text-slate-500 dark:text-slate-400">{fs.text}</span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-slate-500 dark:text-slate-400">{k}</dt>
            <dd className="break-words">{v}</dd>
          </div>
        ))}
      </dl>
      {canWrite ? (
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          <button
            type="button"
            disabled={busy || pushing}
            onClick={onToggle}
            className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            {pushing ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : p.adminEnabled ? <PowerOff className="h-3.5 w-3.5" aria-hidden /> : <Power className="h-3.5 w-3.5" aria-hidden />}
            {pushing ? "Pushing…" : p.adminEnabled ? "Shut down" : "Enable"}
          </button>
          <button type="button" onClick={onEdit} className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800">
            <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs text-rose-700 hover:bg-rose-50 dark:border-slate-700 dark:text-rose-300 dark:hover:bg-rose-900/30"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * One FaceItem per port, each physical slot used once: an uplink cage can be in the desired config under two names
 * (Gi1/1/1 and Te1/1/1, from whichever module was fitted before), and the one the switch has reported on is the
 * one that is really there. The other joins the "other interfaces" strip, so nothing is hidden.
 */
function faceItems(ports: CiscoPortRow[], layout: FaceplateLayout): FaceItem[] {
  const sorted = [...ports].sort((a, b) => a.portId.localeCompare(b.portId, undefined, { numeric: true }));
  const claimed = new Map<string, CiscoPortRow>();
  for (const p of sorted) {
    const slot = slotForPort(p.portId, layout);
    if (slot === null) continue;
    const cur = claimed.get(slot);
    if (!cur || (cur.operStatus === null && p.operStatus !== null)) claimed.set(slot, p);
  }
  return sorted.map((p) => {
    const slot = slotForPort(p.portId, layout);
    const fs = faceState(p);
    return {
      id: p.id,
      slot: slot !== null && claimed.get(slot)?.id === p.id ? slot : null,
      label: p.portId,
      state: fs.state,
      stateText: fs.text,
      poe: p.poe && poeProviding(p.poe) ? poeSummary(p.poe) : undefined,
    };
  });
}

export default function CiscoSwitchDetailPage() {
  const { id } = useParams<{ id: string }>();
  const canWrite = useCanWrite();
  const [sw, setSw] = useState<CiscoSwitch | null>(null);
  // The switch was deleted (an old notification can still link here).
  const [gone, setGone] = useState(false);
  const [ports, setPorts] = useState<CiscoPortRow[]>([]);
  const [vlans, setVlans] = useState<CiscoSwitchVlan[]>([{ vlanId: 1, name: "default" }]);
  const [form, setForm] = useState<PortForm | null>(null);
  const [switchForm, setSwitchForm] = useState<SwitchFormState | null>(null);
  const [confirmDel, setConfirmDel] = useState<CiscoPortRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmTrust, setConfirmTrust] = useState(false);
  // Ports whose shutdown / no shutdown is on its way to the switch (the server sends it in the background), by port row
  // id. Several can be under way at once; the server makes the pushes to this one switch take turns.
  const [pushingPorts, setPushingPorts] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [view, setView] = usePortView();
  const { models } = useSwitchModels();

  const load = useCallback(async () => {
    const [s, p, v] = await Promise.all([
      fetch(`/api/cisco/switches/${id}`, { credentials: "same-origin", cache: "no-store" }),
      fetch(`/api/cisco/switches/${id}/ports`, { credentials: "same-origin", cache: "no-store" }),
      fetch(`/api/cisco/switches/${id}/vlans`, { credentials: "same-origin", cache: "no-store" }),
    ]);
    if (s.ok) setSw((await s.json()) as CiscoSwitch);
    setGone(s.status === 404);
    if (p.ok) setPorts((await p.json()) as CiscoPortRow[]);
    if (v.ok) setVlans((await v.json()) as CiscoSwitchVlan[]);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    setBusy(true);
    setStatus(null);
    try {
      const editing = Boolean(form.id);
      const body = {
        portId: form.portId.trim(),
        description: form.description,
        adminEnabled: form.adminEnabled,
        speed: form.speed,
        duplex: form.duplex,
        mode: form.mode,
        hasSwitchport: form.hasSwitchport,
        accessVlan: form.accessVlan,
        trunkNativeVlan: form.trunkNativeVlan,
        trunkAllowedVlans: form.trunkAllowedVlans,
      };
      const r = await fetch(
        editing ? `/api/cisco/switches/${id}/ports/${form.id}` : `/api/cisco/switches/${id}/ports`,
        {
          method: editing ? "PATCH" : "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { message?: string };
        setStatus({ ok: false, text: b.message ?? `Failed (${r.status})` });
        return;
      }
      setStatus({ ok: true, text: editing ? "Port saved." : "Port added to the desired config." });
      setForm(null);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function toggleAdmin(p: CiscoPortRow) {
    if (pushingPorts[p.id]) return;
    const verb = p.adminEnabled ? "shutdown" : "no shutdown";
    setPushingPorts((m) => ({ ...m, [p.id]: `Pushing ${p.portId} ${verb} to the switch and saving its config.` }));
    try {
      await fetch(`/api/cisco/switches/${id}/ports/${p.id}/toggle`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !p.adminEnabled }),
      });
      // The switch is configured in the background, so there is no completion to wait for: keep the spinner for the
      // few seconds a push takes, then reload to show the saved state.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await load();
    } finally {
      setPushingPorts((m) => {
        const next = { ...m };
        delete next[p.id];
        return next;
      });
    }
  }

  async function trustNewHostKey() {
    setBusy(true);
    try {
      const r = await fetch(`/api/cisco/switches/${id}/reset-host-key`, { method: "POST", credentials: "same-origin" });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { message?: string };
        setStatus({ ok: false, text: b.message ?? `Failed (${r.status})` });
        return;
      }
      setConfirmTrust(false);
      setStatus({ ok: true, text: "Forgot the old host key. The switch is being polled and the key it presents now will be recorded." });
      setTimeout(() => void load(), 5000);
    } finally {
      setBusy(false);
    }
  }

  async function doDelete() {
    if (!confirmDel) return;
    setBusy(true);
    try {
      await fetch(`/api/cisco/switches/${id}/ports/${confirmDel.id}`, { method: "DELETE", credentials: "same-origin" });
      setConfirmDel(null);
      await load();
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<CiscoPortRow>[] = [
    { key: "port", label: "Port", render: (p) => <span className="font-mono text-xs font-medium">{p.portId}</span>, sortValue: (p) => p.portId },
    { key: "desc", label: "Description", render: (p) => <span className="text-xs text-slate-600 dark:text-slate-400">{p.description || "—"}</span>, sortValue: (p) => p.description },
    {
      key: "admin",
      label: "Admin",
      render: (p) =>
        canWrite ? (
          <button
            type="button"
            disabled={busy || !!pushingPorts[p.id]}
            onClick={() => void toggleAdmin(p)}
            className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-60 ${
              p.adminEnabled
                ? "border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-900/30"
                : "border-slate-300 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
            }`}
          >
            {!!pushingPorts[p.id] ? (
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
            ) : p.adminEnabled ? (
              <Power className="h-3 w-3" aria-hidden />
            ) : (
              <PowerOff className="h-3 w-3" aria-hidden />
            )}
            {!!pushingPorts[p.id] ? "pushing…" : p.adminEnabled ? "enabled" : "shut"}
          </button>
        ) : (
          <span className="text-xs">{p.adminEnabled ? "enabled" : "shut"}</span>
        ),
      sortValue: (p) => (p.adminEnabled ? 1 : 0),
    },
    { key: "mode", label: "Mode", render: (p) => <span className="text-xs">{p.hasSwitchport ? p.mode : "routed"}</span>, sortValue: (p) => p.mode },
    {
      key: "vlan",
      label: "VLAN / trunk",
      render: (p) => (
        <span className="text-xs">
          {p.mode === "trunk" ? `native ${p.trunkNativeVlan} · ${p.trunkAllowedVlans}` : p.hasSwitchport ? `vlan ${p.accessVlan}` : "—"}
        </span>
      ),
      sortValue: (p) => (p.mode === "trunk" ? p.trunkNativeVlan : p.accessVlan),
    },
    { key: "speed", label: "Speed", render: (p) => <span className="text-xs">{speedLabel(p.speed)}</span>, sortValue: (p) => p.speed },
    {
      key: "live",
      label: "Live",
      render: (p) => {
        const s = p.operStatus;
        const cls = s === "up" ? "text-emerald-700 dark:text-emerald-400" : s === "err-disabled" ? "text-rose-600 dark:text-rose-400" : "text-slate-500";
        return <span className={`text-xs ${cls}`}>{s ?? "—"}</span>;
      },
      sortValue: (p) => p.operStatus ?? "",
    },
    ...(ports.some((p) => p.poe)
      ? [
          {
            key: "poe",
            label: "PoE",
            render: (p: CiscoPortRow) =>
              poeProviding(p.poe) && p.poe ? (
                <span className="inline-flex items-center gap-1 text-xs">
                  <Zap aria-hidden className="h-3.5 w-3.5 text-amber-500" fill="currentColor" />
                  {poeSummary(p.poe)}
                </span>
              ) : (
                <span className="text-xs text-slate-500 dark:text-slate-400">{p.poe ? "off" : "—"}</span>
              ),
            sortValue: (p: CiscoPortRow) => (poeProviding(p.poe) ? (p.poe?.measuredMw ?? p.poe?.allocatedMw ?? 0) : -1),
          },
        ]
      : []),
    { key: "neighbor", label: "Neighbor", render: (p) => <span className="text-xs text-slate-500 dark:text-slate-400">{p.neighborHostname ?? "—"}</span>, sortValue: (p) => p.neighborHostname ?? "" },
    ...(canWrite
      ? [
          {
            key: "actions",
            label: "",
            align: "right" as const,
            render: (p: CiscoPortRow) => (
              <div className="flex items-center justify-end gap-1.5">
                <button
                  type="button"
                  onClick={() => setForm(portToForm(p))}
                  className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDel(p)}
                  aria-label={`Remove the desired-config entry for ${p.portId}`}
                  className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs text-rose-700 hover:bg-rose-50 dark:border-slate-700 dark:text-rose-300 dark:hover:bg-rose-900/30"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </button>
              </div>
            ),
          },
        ]
      : []),
  ];

  // Which picture this switch gets: an admin's choice for it, else a model whose match string is in its model text, else
  // the built-in drawing for a few Cisco models (resolveSwitchView says which, for the line under the header).
  const switchView = resolveSwitchView(models ?? [], { model: sw?.model, switchModelId: sw?.switchModelId, switchViewOff: sw?.switchViewOff });
  const layout = switchView.layout;
  const showFaceplate = view === "switch" && layout !== null && ports.length > 0;
  const toggle = layout ? <PortViewToggle value={view} onChange={setView} /> : null;

  if (gone) return <GoneNotice what="switch" backHref="/monitoring/network-cisco" backLabel="All switches" />;

  return (
    <div className="space-y-4">
      <Link href="/monitoring/network-cisco" className="inline-flex items-center gap-1 text-sm text-brand-600 hover:underline dark:text-brand-400">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> All switches
      </Link>

      {sw ? (
        <div className="flex flex-wrap items-center gap-3">
          <StatusPill status={computeStatus(sw)} />
          <span className="text-lg font-semibold">{sw.hostname}</span>
          <span className="font-mono text-xs text-slate-500 dark:text-slate-400">{sw.ipAddress}</span>
          {sw.model ? <span className="text-xs text-slate-500 dark:text-slate-400">{sw.model}</span> : null}
          <Link
            href={`/print/cisco/${id}`}
            className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            <Printer className="h-4 w-4" aria-hidden /> Printable page
          </Link>
          {canWrite ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={async () => {
                  await fetch(`/api/cisco/switches/${id}/discover`, { method: "POST", credentials: "same-origin" });
                  setStatus({ ok: true, text: "Re-importing the port baseline from the switch…" });
                  setTimeout(() => void load(), 5000);
                }}
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
              >
                <DownloadCloud className="h-4 w-4" aria-hidden /> Re-import ports
              </button>
              <button
                type="button"
                onClick={() => setForm({ ...EMPTY })}
                className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
              >
                <Plus className="h-4 w-4" aria-hidden /> Add port
              </button>
              <button
                type="button"
                onClick={() => setSwitchForm(formFromSwitch(sw))}
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
              >
                <Pencil className="h-4 w-4" aria-hidden /> Edit switch
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {sw && models !== null ? (
        <SwitchViewLine view={switchView} deviceModel={sw.model} canWrite={canWrite} />
      ) : null}

      {Object.entries(pushingPorts).map(([portRowId, text]) => (
        <PendingLine key={portRowId} text={text} />
      ))}
      <StatusLine status={status} />

      {sw?.lastError && /host key/i.test(sw.lastError) ? (
        <div role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          <p>{sw.lastError}</p>
          {canWrite ? (
            confirmTrust ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span>Only do this if you know the switch was replaced or its SSH keys were regenerated.</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void trustNewHostKey()}
                  className="rounded-md bg-amber-700 px-3 py-1 text-white hover:bg-amber-800 disabled:opacity-50"
                >
                  Yes, trust the new key
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmTrust(false)}
                  className="rounded-md border border-amber-400 px-3 py-1 hover:bg-amber-100 dark:hover:bg-amber-900"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmTrust(true)}
                className="mt-2 rounded-md border border-amber-400 px-3 py-1 hover:bg-amber-100 dark:hover:bg-amber-900"
              >
                Trust new host key
              </button>
            )
          ) : null}
        </div>
      ) : null}

      {showFaceplate && layout ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {ports.filter((p) => p.operStatus === "up").length} of {ports.length} interfaces up.
              {poeInUse(ports) ? ` ${poeInUse(ports)} of PoE in use.` : ""} Hover a port for its details.
            </span>
            {toggle}
          </div>
          <SwitchFaceplate
            layout={layout}
            items={faceItems(ports, layout)}
            renderDetails={(portRowId, close) => {
              const p = ports.find((x) => x.id === portRowId);
              if (!p) return null;
              return (
                <PortDetails
                  p={p}
                  canWrite={canWrite}
                  busy={busy}
                  pushing={!!pushingPorts[p.id]}
                  onToggle={() => {
                    close();
                    void toggleAdmin(p);
                  }}
                  onEdit={() => {
                    close();
                    setForm(portToForm(p));
                  }}
                  onDelete={() => {
                    close();
                    setConfirmDel(p);
                  }}
                />
              );
            }}
          />
        </div>
      ) : (
      <DataTable
        rightSlot={toggle}
        rowsSelector="footer"
        rows={ports}
        columns={columns}
        getKey={(p) => p.id}
        initialSort={{ key: "port", dir: "asc" }}
        filterPlaceholder="Filter ports…"
        emptyText="No ports imported yet. Poll the switch to import its interfaces as the baseline."
      />
      )}

      {form ? (
        <Modal title={form.id ? `Edit ${form.portId}` : "Add port"} onClose={() => setForm(null)}>
          <form onSubmit={save} className="space-y-3 text-sm">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Port ID *">
                <input required disabled={Boolean(form.id)} value={form.portId} onChange={(e) => setForm({ ...form, portId: e.target.value })} placeholder="Gi1/0/1" className={`w-full font-mono text-xs disabled:opacity-60 ${inputCls}`} />
              </Field>
              <Field label="Description">
                <input value={form.description} maxLength={128} onChange={(e) => setForm({ ...form, description: e.target.value })} className={`w-full ${inputCls}`} />
              </Field>
              <Field label="Mode">
                <select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as "access" | "trunk" })} className={`w-full ${inputCls}`}>
                  <option value="access">access</option>
                  <option value="trunk">trunk</option>
                </select>
              </Field>
              {form.mode === "access" ? (
                <Field label="Access VLAN">
                  <VlanSelect value={form.accessVlan} vlans={vlans} onChange={(v) => setForm({ ...form, accessVlan: v })} />
                </Field>
              ) : (
                <>
                  <Field label="Native VLAN">
                    <VlanSelect value={form.trunkNativeVlan} vlans={vlans} onChange={(v) => setForm({ ...form, trunkNativeVlan: v })} />
                  </Field>
                  {/* Not a Field: that is a <label>, and a click on blank space in it would flip the first radio inside. */}
                  <div className="sm:col-span-2">
                    <span className="text-xs text-slate-500 dark:text-slate-400">Allowed VLANs</span>
                    <div className="mt-1">
                      <TrunkVlanField value={form.trunkAllowedVlans} vlans={vlans} onChange={(list) => setForm({ ...form, trunkAllowedVlans: list })} />
                    </div>
                  </div>
                </>
              )}
              <Field label="Speed">
                <select value={normaliseSpeed(form.speed)} onChange={(e) => setForm({ ...form, speed: e.target.value })} className={`w-full ${inputCls}`}>
                  {speedOptions(form.speed).map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
              </Field>
              <Field label="Duplex">
                <select value={normaliseDuplex(form.duplex)} onChange={(e) => setForm({ ...form, duplex: e.target.value })} className={`w-full ${inputCls}`}>
                  {CISCO_DUPLEX_CHOICES.map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
              </Field>
            </div>
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={form.adminEnabled} onChange={(e) => setForm({ ...form, adminEnabled: e.target.checked })} className="h-4 w-4 rounded border-slate-300 text-brand-600 dark:text-brand-400 dark:border-slate-700" />
              <span>Admin enabled (desired)</span>
            </label>
            <div className="flex items-center justify-end gap-2 pt-1">
              <button type="button" onClick={() => setForm(null)} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700">
                Cancel
              </button>
              <button type="submit" disabled={busy} className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60">
                {form.id ? "Save" : "Add port"}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {switchForm ? (
        <SwitchFormModal
          initial={switchForm}
          onClose={() => setSwitchForm(null)}
          onSaved={async (text) => {
            setStatus({ ok: true, text });
            setSwitchForm(null);
            await load();
          }}
        />
      ) : null}

      {confirmDel ? (
        <Modal title="Delete port" onClose={() => setConfirmDel(null)}>
          <p className="text-sm">
            Remove the desired-config entry for <span className="font-mono">{confirmDel.portId}</span>? This only edits the
            baseline; it does not change the switch.
          </p>
          <div className="mt-4 flex items-center justify-end gap-2">
            <button type="button" onClick={() => setConfirmDel(null)} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700">
              Cancel
            </button>
            <button type="button" onClick={() => void doDelete()} disabled={busy} className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-60">
              Delete
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
