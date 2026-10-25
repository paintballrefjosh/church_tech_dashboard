"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { FileUp, ImageOff, Pencil, Plus, Trash2 } from "lucide-react";
import { SWITCH_MODEL_SIDES, type SwitchModel, type SwitchModelKind, type SwitchModelSide } from "@church/shared";
import { useCanWrite, Modal, Field, inputCls, StatusLine } from "@/app/monitoring/network-cisco/cisco-ui";
import { errorText, useSwitchModels } from "@/lib/use-switch-models";
import { DataTable, type Column } from "@/components/data-table";
import { StencilImporter } from "@/components/stencil-importer";

interface Form {
  name: string;
  kind: SwitchModelKind;
  match: string;
  portSide: SwitchModelSide;
}

function splitMatch(text: string): string[] {
  return text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
}

/**
 * The admin's device models: one list shared by the Cisco, UniFi and Infrastructure pages, each of which mounts this under
 * its own `base` (so the links stay inside the section the person came from).
 */
export function SwitchModelsPage({ base: BASE }: { base: string }) {
  const canWrite = useCanWrite();
  const { models, reload } = useSwitchModels();
  const params = useSearchParams();
  const [form, setForm] = useState<Form | null>(null);
  const [confirmDel, setConfirmDel] = useState<SwitchModel | null>(null);
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  // "Set up the switch view for this model" on a switch page arrives here with the model text to match.
  const prefill = params.get("create");
  useEffect(() => {
    if (prefill && canWrite) setForm({ name: prefill, kind: "switch", match: prefill, portSide: "front" });
  }, [prefill, canWrite]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    setBusy(true);
    setStatus(null);
    try {
      const r = await fetch("/api/switch-models", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: form.name, kind: form.kind, match: form.kind === "module" ? [] : splitMatch(form.match), portSide: form.portSide }),
      });
      if (!r.ok) {
        setStatus({ ok: false, text: await errorText(r) });
        return;
      }
      const m = (await r.json()) as SwitchModel;
      window.location.assign(`${BASE}/${m.id}`);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirmDel) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/switch-models/${confirmDel.id}`, { method: "DELETE", credentials: "same-origin" });
      if (!r.ok) setStatus({ ok: false, text: await errorText(r) });
      else setStatus({ ok: true, text: `Deleted ${confirmDel.name}.` });
      setConfirmDel(null);
      await reload();
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<SwitchModel>[] = [
    {
      key: "name",
      label: "Model",
      render: (m) => (
        <Link href={`${BASE}/${m.id}`} className="font-medium text-brand-600 hover:underline dark:text-brand-400">
          {m.name}
        </Link>
      ),
      sortValue: (m) => m.name,
    },
    {
      key: "kind",
      label: "Type",
      render: (m) => <span className="text-xs">{m.kind === "module" ? "Add-on module" : "Switch"}</span>,
      sortValue: (m) => m.kind,
    },
    {
      key: "match",
      label: "Matches",
      render: (m) =>
        m.kind === "module" ? (
          <span className="text-xs text-slate-500 dark:text-slate-400">placed on {models?.filter((h) => h.modules.some((p) => p.moduleId === m.id)).length ?? 0} models</span>
        ) : (
          <span className="font-mono text-xs">{m.match.join(", ") || "—"}</span>
        ),
      sortValue: (m) => m.match.join(" "),
    },
    {
      key: "pictures",
      label: "Pictures",
      render: (m) => {
        const have = [m.frontImageId ? "front" : null, m.backImageId ? "back" : null].filter(Boolean);
        return have.length ? (
          <span className="text-xs">{have.join(" and ")}</span>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400"><ImageOff className="h-3.5 w-3.5" aria-hidden /> none yet</span>
        );
      },
      sortValue: (m) => Number(Boolean(m.frontImageId)) + Number(Boolean(m.backImageId)),
    },
    { key: "ports", label: "Ports", render: (m) => <span className="text-xs">{m.ports.length}</span>, sortValue: (m) => m.ports.length },
    ...(canWrite
      ? [
          {
            key: "actions",
            label: "",
            align: "right" as const,
            render: (m: SwitchModel) => (
              <div className="flex items-center justify-end gap-1.5">
                <Link href={`${BASE}/${m.id}`} className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800">
                  <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit
                </Link>
                <button
                  type="button"
                  onClick={() => setConfirmDel(m)}
                  aria-label={`Delete the ${m.kind === "module" ? "module" : "switch model"} ${m.name}`}
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
      <div className="flex flex-wrap items-start gap-3">
        <p className="max-w-2xl text-sm text-slate-600 dark:text-slate-400">
          A model is a picture of a kind of device (a switch, an access point, a server) with its ports marked on it. A device whose model matches one of the strings below is shown as that picture; a Cisco switch also gets each port as a button on its page, and a cabinet or printed port sheet uses the picture for any device. The same models are listed on the Cisco, UniFi and Infrastructure pages.
          An add-on module (a network module such as the C3KX-NM-10G) is the same for a plug-in card: you place it on the switch models that take it, and it appears only on switches that report its ports.
        </p>
        {canWrite ? (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setImporting(true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              <FileUp className="h-4 w-4" aria-hidden /> Import from a file
            </button>
            <button
              type="button"
              onClick={() => setForm({ name: "", kind: "module", match: "", portSide: "front" })}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              <Plus className="h-4 w-4" aria-hidden /> New add-on module
            </button>
            <button
              type="button"
              onClick={() => setForm({ name: "", kind: "switch", match: "", portSide: "front" })}
              className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
            >
              <Plus className="h-4 w-4" aria-hidden /> New switch model
            </button>
          </div>
        ) : null}
      </div>
      <StatusLine status={status} />

      <DataTable
        rows={models ?? []}
        columns={columns}
        getKey={(m) => m.id}
        initialSort={{ key: "name", dir: "asc" }}
        filterPlaceholder="Filter models…"
        emptyText={models === null ? "Loading…" : "No switch models yet. Switches of a model without one are shown as a list of ports (or a rough built-in drawing for a few Cisco models)."}
      />

      {importing ? (
        <StencilImporter
          models={models ?? []}
          onClose={() => setImporting(false)}
          onDone={(m) => {
            window.location.assign(`${BASE}/${m.id}`);
          }}
        />
      ) : null}

      {form ? (
        <Modal title={form.kind === "module" ? "New add-on module" : "New switch model"} onClose={() => setForm(null)}>
          <form onSubmit={create} className="space-y-3 text-sm">
            <Field label="Name *">
              <input required autoFocus maxLength={80} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={form.kind === "module" ? "C3KX-NM-10G" : "Catalyst 3850, 48 port PoE+"} className={`w-full ${inputCls}`} />
            </Field>
            {form.kind === "module" ? (
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Add the module's picture and mark its ports with the names the switch gives them (<span className="font-mono">Te1/1/1</span> ...). Then open a switch model and add the module to it.
              </p>
            ) : (
              <>
                <Field label="Matches (the model text the switch reports, comma separated)">
                  <input value={form.match} onChange={(e) => setForm({ ...form, match: e.target.value })} placeholder="C3850-48" className={`w-full font-mono text-xs ${inputCls}`} />
                </Field>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  A switch uses this model when its reported model contains one of these strings, in any case: <span className="font-mono">C3850-48</span> matches WS-C3850-48F-E and WS-C3850-48P-L. If several match, the longest string wins.
                </p>
              </>
            )}
            <Field label="The ports are on the">
              <select value={form.portSide} onChange={(e) => setForm({ ...form, portSide: e.target.value as SwitchModelSide })} className={`w-full ${inputCls}`}>
                {SWITCH_MODEL_SIDES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </Field>
            <div className="flex items-center justify-end gap-2 pt-1">
              <button type="button" onClick={() => setForm(null)} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700">Cancel</button>
              <button type="submit" disabled={busy} className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60">Create and add pictures</button>
            </div>
          </form>
        </Modal>
      ) : null}

      {confirmDel ? (
        <Modal title="Delete switch model" onClose={() => setConfirmDel(null)}>
          <p className="text-sm">
            Delete <span className="font-medium">{confirmDel.name}</span>, its pictures and its port layout?{" "}
            {confirmDel.kind === "module" ? "A module that is placed on a switch model has to be removed from it first." : "Switches that used it go back to a list of ports."}
          </p>
          <div className="mt-4 flex items-center justify-end gap-2">
            <button type="button" onClick={() => setConfirmDel(null)} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700">Cancel</button>
            <button type="button" onClick={() => void remove()} disabled={busy} className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-60">Delete</button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
