"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import {
  defaultVlanName,
  isManagedVlan,
  vlanNameSchema,
  type CiscoSwitch,
  type CiscoVlanRow,
  type CiscoVlanSetResult,
  type CiscoVlanState,
} from "@church/shared";
import { DataTable, type Column } from "@/components/data-table";
import { Field, Modal, ToastStack, inputCls, useCanWrite, useToasts } from "../cisco-ui";

const CHIP_BASE = "rounded px-1.5 py-0.5 text-[10px]";
const CHIP: Record<CiscoVlanState, { cls: string; note: string; title: string }> = {
  in_sync: {
    cls: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
    note: "",
    title: "The switch has this VLAN as wanted",
  },
  missing: {
    cls: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
    note: " (to add)",
    title: "Wanted on this switch but not there yet: push it from the Drift log",
  },
  extra: {
    cls: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
    note: " (not wanted)",
    title: "On the switch but not in the wanted list: accept it or push its removal from the Drift log",
  },
  name: {
    cls: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300",
    note: " (rename)",
    title: "The switch calls it something else: push the wanted name or accept the switch's from the Drift log",
  },
};

interface VlanForm {
  /** Set while editing; an id typed by the person while adding. */
  vlanId: string;
  editing: boolean;
  name: string;
  switchIds: string[];
}

const wantedName = (v: CiscoVlanRow): string => {
  const d = v.switches.find((s) => s.desiredName !== null);
  if (d) return d.desiredName!;
  return v.switches[0]?.vlanName ?? defaultVlanName(v.vlanId);
};

export default function CiscoVlansPage() {
  const canWrite = useCanWrite();
  const [vlans, setVlans] = useState<CiscoVlanRow[] | null>(null);
  const [switches, setSwitches] = useState<CiscoSwitch[]>([]);
  const [conflictsOnly, setConflictsOnly] = useState(false);
  const [pendingOnly, setPendingOnly] = useState(false);
  const [form, setForm] = useState<VlanForm | null>(null);
  const [confirmDel, setConfirmDel] = useState<CiscoVlanRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const { toasts, show, dismiss } = useToasts();

  const load = useCallback(async () => {
    const [v, s] = await Promise.all([
      fetch("/api/cisco/vlans", { credentials: "same-origin", cache: "no-store" }),
      fetch("/api/cisco/switches", { credentials: "same-origin", cache: "no-store" }),
    ]);
    if (v.ok) setVlans((await v.json()) as CiscoVlanRow[]);
    if (s.ok) setSwitches((await s.json()) as CiscoSwitch[]);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!vlans) return <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>;

  const conflicts = vlans.filter((v) => v.nameConflict).length;
  const pending = vlans.filter((v) => v.switches.some((s) => s.state !== "in_sync")).length;
  const rows = vlans.filter((v) => (!conflictsOnly || v.nameConflict) && (!pendingOnly || v.switches.some((s) => s.state !== "in_sync")));

  function openAdd() {
    setFormError(null);
    setForm({ vlanId: "", editing: false, name: "", switchIds: switches.map((s) => s.id) });
  }

  function openEdit(v: CiscoVlanRow) {
    setFormError(null);
    const wanted = v.switches.filter((s) => s.desired).map((s) => s.switchId);
    setForm({
      vlanId: String(v.vlanId),
      editing: true,
      name: v.switches.some((s) => s.desired) ? (v.switches.find((s) => s.desired)!.desiredName === defaultVlanName(v.vlanId) ? "" : v.switches.find((s) => s.desired)!.desiredName ?? "") : "",
      switchIds: wanted,
    });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    const id = Number(form.vlanId);
    if (!isManagedVlan(id)) {
      setFormError("Use a VLAN id from 2 to 4094, not 1002-1005 (VLAN 1 and those exist on every switch).");
      return;
    }
    const name = vlanNameSchema.safeParse(form.name);
    if (!name.success) {
      setFormError("A name is up to 32 letters, digits, dot, dash or underscore (no spaces).");
      return;
    }
    if (form.switchIds.length === 0) {
      setFormError("Pick at least one switch (use Delete to remove the VLAN everywhere).");
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const r = await fetch(`/api/cisco/vlans/${id}`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.data, switchIds: form.switchIds }),
      });
      const body = (await r.json().catch(() => ({}))) as Partial<CiscoVlanSetResult> & { message?: string };
      if (!r.ok) {
        setFormError(body.message ?? `Failed (${r.status})`);
        return;
      }
      const parts = [
        body.created?.length ? `added on ${body.created.length}` : null,
        body.renamed?.length ? `renamed on ${body.renamed.length}` : null,
        body.removed?.length ? `removed from ${body.removed.length}` : null,
      ].filter(Boolean);
      show(true, `VLAN ${id}: ${parts.length ? parts.join(", ") : "nothing to change"}. Push it from the Drift log.`);
      setForm(null);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function doDelete() {
    if (!confirmDel) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/cisco/vlans/${confirmDel.vlanId}`, { method: "DELETE", credentials: "same-origin" });
      const body = (await r.json().catch(() => ({}))) as { message?: string };
      if (!r.ok) {
        show(false, body.message ?? `Failed (${r.status})`);
      } else {
        show(true, `VLAN ${confirmDel.vlanId} removed from the wanted config. Push the removal from the Drift log.`);
      }
      setConfirmDel(null);
      await load();
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<CiscoVlanRow>[] = [
    { key: "vlanId", label: "VLAN ID", render: (v) => <span className="font-mono font-semibold">{v.vlanId}</span>, sortValue: (v) => v.vlanId },
    {
      key: "name",
      label: "Name",
      render: (v) =>
        v.nameConflict ? (
          <span className="space-x-2 text-xs">
            {[...new Set(v.switches.map((s) => s.desiredName ?? s.vlanName ?? defaultVlanName(v.vlanId)))].map((name) => (
              <span key={name} className="text-orange-700 dark:text-orange-300">
                {name}
              </span>
            ))}
            <span className="rounded bg-orange-100 px-1.5 text-[10px] text-orange-700 dark:bg-orange-900/40 dark:text-orange-300">conflict</span>
          </span>
        ) : (
          <span className="text-xs">{wantedName(v)}</span>
        ),
      sortValue: (v) => wantedName(v),
    },
    {
      key: "switches",
      label: "Switches",
      render: (v) => (
        <div className="flex flex-wrap gap-1">
          {v.switches.map((s) => (
            <span key={s.switchId} title={CHIP[s.state].title} className={`${CHIP_BASE} ${CHIP[s.state].cls}`}>
              {s.hostname}
              {CHIP[s.state].note}
            </span>
          ))}
        </div>
      ),
      sortValue: (v) => v.switches.map((s) => s.hostname).join(" "),
    },
    {
      key: "status",
      label: "Status",
      render: (v) => {
        const seen = v.switches.filter((s) => s.vlanStatus !== null);
        if (seen.length === 0) return <span className="text-xs text-slate-500 dark:text-slate-400">not on a switch</span>;
        return seen.every((s) => s.vlanStatus === "active") ? (
          <span className="text-xs text-emerald-700 dark:text-emerald-400">active</span>
        ) : (
          <span className="text-xs text-slate-500 dark:text-slate-400">mixed</span>
        );
      },
      sortValue: (v) => (v.switches.every((s) => s.vlanStatus === "active") ? "active" : "mixed"),
    },
    ...(canWrite
      ? [
          {
            key: "actions",
            label: "Actions",
            align: "right" as const,
            render: (v: CiscoVlanRow) =>
              v.managed ? (
                <div className="flex items-center justify-end gap-1.5">
                  <button
                    type="button"
                    onClick={() => openEdit(v)}
                    className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
                  >
                    <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDel(v)}
                    className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs text-rose-700 hover:bg-rose-50 dark:border-slate-700 dark:text-rose-300 dark:hover:bg-rose-900/30"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete
                  </button>
                </div>
              ) : (
                <span className="text-[10px] text-slate-500 dark:text-slate-400" title="VLAN 1 and 1002-1005 exist on every switch and are never changed">
                  built in
                </span>
              ),
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">VLAN database</h2>
        {conflicts > 0 ? (
          <span className="rounded-full bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-700 dark:bg-orange-900/40 dark:text-orange-300">
            {conflicts} name conflict{conflicts === 1 ? "" : "s"}
          </span>
        ) : null}
        {pending > 0 ? (
          <Link
            href="/monitoring/network-cisco/drift"
            className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 hover:underline dark:bg-amber-900/40 dark:text-amber-300"
          >
            {pending} VLAN{pending === 1 ? "" : "s"} differ from the wanted config: review in the Drift log
          </Link>
        ) : null}
      </div>

      <DataTable
        rows={rows}
        columns={columns}
        getKey={(v) => String(v.vlanId)}
        initialSort={{ key: "vlanId", dir: "asc" }}
        initialPageSize={50}
        filterPlaceholder="Search by VLAN id, name, or switch…"
        emptyText="No VLANs found. Run a poll to collect VLAN data."
        rightSlot={
          <>
            <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-400">
              <input type="checkbox" checked={conflictsOnly} onChange={(e) => setConflictsOnly(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-brand-600 dark:text-brand-400 dark:border-slate-700" />
              Conflicts only
            </label>
            <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-400">
              <input type="checkbox" checked={pendingOnly} onChange={(e) => setPendingOnly(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-brand-600 dark:text-brand-400 dark:border-slate-700" />
              Not in sync only
            </label>
            <button type="button" onClick={() => void load()} className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800">
              <RefreshCw className="h-4 w-4" aria-hidden /> Refresh
            </button>
            {canWrite ? (
              <button type="button" onClick={openAdd} className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700">
                <Plus className="h-4 w-4" aria-hidden /> Add VLAN
              </button>
            ) : null}
          </>
        }
      />

      {form ? (
        <Modal title={form.editing ? `Edit VLAN ${form.vlanId}` : "Add VLAN"} onClose={() => setForm(null)}>
          <form onSubmit={save} className="space-y-3 text-sm">
            <p className="rounded-md border border-brand-300 bg-brand-50 px-3 py-2 text-xs text-brand-800 dark:border-brand-700 dark:bg-brand-900/30 dark:text-brand-200">
              This changes the wanted config. A switch is only changed when you push the difference from the Drift log.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="VLAN ID *">
                <input
                  required
                  inputMode="numeric"
                  disabled={form.editing}
                  value={form.vlanId}
                  onChange={(e) => setForm({ ...form, vlanId: e.target.value.replace(/\D/g, "").slice(0, 4) })}
                  className={`w-full font-mono ${inputCls}`}
                />
              </Field>
              <Field label="Name">
                <input
                  value={form.name}
                  maxLength={32}
                  placeholder={form.vlanId ? defaultVlanName(Number(form.vlanId) || 0) : "default name"}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className={`w-full ${inputCls}`}
                />
              </Field>
            </div>
            <fieldset>
              <legend className="text-xs text-slate-500 dark:text-slate-400">Switches that should have this VLAN</legend>
              <div className="mt-1 max-h-48 space-y-1 overflow-y-auto rounded-md border border-slate-200 p-2 dark:border-slate-800">
                {switches.map((s) => (
                  <label key={s.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={form.switchIds.includes(s.id)}
                      onChange={(e) =>
                        setForm({ ...form, switchIds: e.target.checked ? [...form.switchIds, s.id] : form.switchIds.filter((x) => x !== s.id) })
                      }
                      className="h-4 w-4 rounded border-slate-300 text-brand-600 dark:text-brand-400 dark:border-slate-700"
                    />
                    {s.hostname}
                  </label>
                ))}
              </div>
              <div className="mt-1 flex gap-3 text-xs">
                <button type="button" onClick={() => setForm({ ...form, switchIds: switches.map((s) => s.id) })} className="text-brand-600 hover:underline dark:text-brand-400">
                  All
                </button>
                <button type="button" onClick={() => setForm({ ...form, switchIds: [] })} className="text-brand-600 hover:underline dark:text-brand-400">
                  None
                </button>
              </div>
            </fieldset>
            {formError ? <p className="text-xs text-rose-600 dark:text-rose-400">{formError}</p> : null}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setForm(null)} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700">
                Cancel
              </button>
              <button type="submit" disabled={busy} className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60">
                {form.editing ? "Save" : "Add VLAN"}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {confirmDel ? (
        <Modal title={`Delete VLAN ${confirmDel.vlanId}?`} onClose={() => setConfirmDel(null)}>
          <p className="text-sm text-slate-600 dark:text-slate-300">
            This takes VLAN {confirmDel.vlanId} ({wantedName(confirmDel)}) out of the wanted config of every switch. It stays on the switches until you
            push the removal from the Drift log. It is refused while a port, a trunk native VLAN or a VLAN interface still uses it.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => setConfirmDel(null)} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700">
              Cancel
            </button>
            <button type="button" onClick={() => void doDelete()} disabled={busy} className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-60">
              Delete
            </button>
          </div>
        </Modal>
      ) : null}

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
