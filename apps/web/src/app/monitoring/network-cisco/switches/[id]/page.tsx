"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Plus, Pencil, Trash2, Power, PowerOff, DownloadCloud } from "lucide-react";
import type { CiscoSwitch, CiscoPortRow } from "@church/shared";
import { useCanWrite, StatusPill, computeStatus, StatusLine, Modal, Field, inputCls } from "../../cisco-ui";
import { DataTable, type Column } from "@/components/data-table";

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

export default function CiscoSwitchDetailPage() {
  const { id } = useParams<{ id: string }>();
  const canWrite = useCanWrite();
  const [sw, setSw] = useState<CiscoSwitch | null>(null);
  const [ports, setPorts] = useState<CiscoPortRow[]>([]);
  const [form, setForm] = useState<PortForm | null>(null);
  const [confirmDel, setConfirmDel] = useState<CiscoPortRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const [s, p] = await Promise.all([
      fetch(`/api/cisco/switches/${id}`, { credentials: "same-origin", cache: "no-store" }),
      fetch(`/api/cisco/switches/${id}/ports`, { credentials: "same-origin", cache: "no-store" }),
    ]);
    if (s.ok) setSw((await s.json()) as CiscoSwitch);
    if (p.ok) setPorts((await p.json()) as CiscoPortRow[]);
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
    setBusy(true);
    try {
      await fetch(`/api/cisco/switches/${id}/ports/${p.id}/toggle`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !p.adminEnabled }),
      });
      setStatus({ ok: true, text: `Pushing ${p.portId} ${p.adminEnabled ? "shutdown" : "no shutdown"} to the switch…` });
      setTimeout(() => void load(), 3000);
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
            disabled={busy}
            onClick={() => void toggleAdmin(p)}
            className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-60 ${
              p.adminEnabled
                ? "border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-900/30"
                : "border-slate-300 text-slate-500 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
            }`}
          >
            {p.adminEnabled ? <Power className="h-3 w-3" aria-hidden /> : <PowerOff className="h-3 w-3" aria-hidden />}
            {p.adminEnabled ? "enabled" : "shut"}
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
    { key: "speed", label: "Speed", render: (p) => <span className="text-xs">{p.speed}</span>, sortValue: (p) => p.speed },
    {
      key: "live",
      label: "Live",
      render: (p) => {
        const s = p.operStatus;
        const cls = s === "up" ? "text-emerald-600 dark:text-emerald-400" : s === "err-disabled" ? "text-rose-600 dark:text-rose-400" : "text-slate-500";
        return <span className={`text-xs ${cls}`}>{s ?? "—"}</span>;
      },
      sortValue: (p) => p.operStatus ?? "",
    },
    { key: "neighbor", label: "Neighbor", render: (p) => <span className="text-xs text-slate-500">{p.neighborHostname ?? "—"}</span>, sortValue: (p) => p.neighborHostname ?? "" },
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
                  onClick={() =>
                    setForm({
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
                    })
                  }
                  className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDel(p)}
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

  return (
    <div className="space-y-4">
      <Link href="/monitoring/network-cisco" className="inline-flex items-center gap-1 text-sm text-brand-600 hover:underline dark:text-brand-400">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> All switches
      </Link>

      {sw ? (
        <div className="flex flex-wrap items-center gap-3">
          <StatusPill status={computeStatus(sw)} />
          <span className="text-lg font-semibold">{sw.hostname}</span>
          <span className="font-mono text-xs text-slate-500">{sw.ipAddress}</span>
          {sw.model ? <span className="text-xs text-slate-500">{sw.model}</span> : null}
          {canWrite ? (
            <div className="ml-auto flex items-center gap-2">
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
            </div>
          ) : null}
        </div>
      ) : null}

      <StatusLine status={status} />

      <DataTable
        rows={ports}
        columns={columns}
        getKey={(p) => p.id}
        initialSort={{ key: "port", dir: "asc" }}
        filterPlaceholder="Filter ports…"
        emptyText="No ports imported yet. Poll the switch to import its interfaces as the baseline."
      />

      {form ? (
        <Modal title={form.id ? `Edit ${form.portId}` : "Add port"} onClose={() => setForm(null)}>
          <form onSubmit={save} className="space-y-3 text-sm">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Port ID *">
                <input required disabled={Boolean(form.id)} value={form.portId} onChange={(e) => setForm({ ...form, portId: e.target.value })} placeholder="Gi1/0/1" className={`w-full font-mono text-xs disabled:opacity-60 ${inputCls}`} />
              </Field>
              <Field label="Description">
                <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className={`w-full ${inputCls}`} />
              </Field>
              <Field label="Mode">
                <select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as "access" | "trunk" })} className={`w-full ${inputCls}`}>
                  <option value="access">access</option>
                  <option value="trunk">trunk</option>
                </select>
              </Field>
              {form.mode === "access" ? (
                <Field label="Access VLAN">
                  <input type="number" min={1} max={4094} value={form.accessVlan} onChange={(e) => setForm({ ...form, accessVlan: Number(e.target.value) || 1 })} className={`w-full ${inputCls}`} />
                </Field>
              ) : (
                <>
                  <Field label="Native VLAN">
                    <input type="number" min={1} max={4094} value={form.trunkNativeVlan} onChange={(e) => setForm({ ...form, trunkNativeVlan: Number(e.target.value) || 1 })} className={`w-full ${inputCls}`} />
                  </Field>
                  <Field label="Allowed VLANs">
                    <input value={form.trunkAllowedVlans} onChange={(e) => setForm({ ...form, trunkAllowedVlans: e.target.value })} className={`w-full font-mono text-xs ${inputCls}`} />
                  </Field>
                </>
              )}
              <Field label="Speed">
                <input value={form.speed} onChange={(e) => setForm({ ...form, speed: e.target.value })} className={`w-full ${inputCls}`} />
              </Field>
              <Field label="Duplex">
                <input value={form.duplex} onChange={(e) => setForm({ ...form, duplex: e.target.value })} className={`w-full ${inputCls}`} />
              </Field>
            </div>
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={form.adminEnabled} onChange={(e) => setForm({ ...form, adminEnabled: e.target.checked })} className="h-4 w-4 rounded border-slate-300 text-brand-600 dark:border-slate-700" />
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
