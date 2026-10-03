"use client";

import { useEffect, useState, useTransition } from "react";
import {
  Printer as PrinterIcon,
  RefreshCw,
  Plus,
  Pencil,
  Trash2,
  X,
  AlertTriangle,
} from "lucide-react";
import {
  PRINTER_KINDS,
  SNMP_VERSIONS,
  type Printer,
  type PrinterStatus,
  type PrinterKind,
} from "@church/shared";

const STATUS_LABEL: Record<PrinterStatus, string> = {
  green: "OK",
  yellow: "Attention",
  red: "Down",
  unknown: "Unknown",
};

const STATUS_DOT: Record<PrinterStatus, string> = {
  green: "bg-emerald-500",
  yellow: "bg-amber-500",
  red: "bg-rose-500",
  unknown: "bg-slate-400",
};

const STATUS_RING: Record<PrinterStatus, string> = {
  green: "ring-emerald-500/30",
  yellow: "ring-amber-500/30",
  red: "ring-rose-500/30",
  unknown: "ring-slate-400/20",
};

const COLORANT_BAR: Record<string, string> = {
  cyan: "bg-cyan-500",
  magenta: "bg-fuchsia-500",
  yellow: "bg-yellow-400",
  black: "bg-slate-800 dark:bg-slate-200",
  other: "bg-slate-500",
};

export function PrintersList({
  initial,
  canAdmin,
}: {
  initial: Printer[];
  canAdmin: boolean;
}) {
  const [printers, setPrinters] = useState<Printer[]>(initial);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Printer | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    const r = await fetch("/api/printers", { credentials: "same-origin", cache: "no-store" });
    if (r.ok) setPrinters((await r.json()) as Printer[]);
  }

  // Auto-refetch every 30s to pick up the API's background poll snapshot.
  useEffect(() => {
    const t = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(t);
  }, []);

  async function pollOne(id: string) {
    const r = await fetch(`/api/printers/${id}/poll`, {
      method: "POST",
      credentials: "same-origin",
    });
    if (r.ok) {
      const updated = (await r.json()) as Printer;
      setPrinters((prev) => prev.map((p) => (p.id === id ? updated : p)));
    } else {
      setErr(`Poll failed (${r.status})`);
    }
  }

  async function destroy(p: Printer) {
    if (!confirm(`Delete printer "${p.name}"?`)) return;
    const r = await fetch(`/api/printers/${p.id}`, {
      method: "DELETE",
      credentials: "same-origin",
    });
    if (r.ok) setPrinters((prev) => prev.filter((x) => x.id !== p.id));
    else setErr(`Delete failed (${r.status})`);
  }

  return (
    <div className="mt-6 space-y-4">
      {err ? (
        <p role="alert" className="text-sm text-rose-600">
          {err}
        </p>
      ) : null}

      {canAdmin ? (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
          >
            <Plus className="h-4 w-4" aria-hidden /> Add printer
          </button>
        </div>
      ) : null}

      {printers.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-300 p-10 text-center text-sm text-slate-500 dark:border-slate-700">
          No printers yet. {canAdmin ? "Click Add printer to register one." : "Ask an admin to add one."}
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {printers.map((p) => (
            <PrinterCard
              key={p.id}
              printer={p}
              canAdmin={canAdmin}
              onPoll={() => void pollOne(p.id)}
              onEdit={() => setEditing(p)}
              onDelete={() => void destroy(p)}
            />
          ))}
        </ul>
      )}

      {adding ? (
        <PrinterFormDrawer
          mode="create"
          onClose={() => {
            setAdding(false);
            void refresh();
          }}
          onError={setErr}
        />
      ) : null}
      {editing ? (
        <PrinterFormDrawer
          mode="edit"
          printer={editing}
          onClose={() => {
            setEditing(null);
            void refresh();
          }}
          onError={setErr}
        />
      ) : null}
    </div>
  );
}

function PrinterCard({
  printer,
  canAdmin,
  onPoll,
  onEdit,
  onDelete,
}: {
  printer: Printer;
  canAdmin: boolean;
  onPoll: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [polling, setPolling] = useState(false);

  async function doPoll() {
    setPolling(true);
    try {
      await onPoll();
    } finally {
      setPolling(false);
    }
  }

  return (
    <li
      className={`relative flex flex-col gap-3 rounded-md border border-slate-300 bg-white p-4 ring-4 ring-inset dark:border-slate-800 dark:bg-slate-900 ${STATUS_RING[printer.lastStatus]}`}
    >
      <header className="flex items-start gap-2">
        <PrinterIcon className="mt-0.5 h-5 w-5 shrink-0 text-slate-500" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{printer.name}</span>
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              {printer.kind}
            </span>
            {!printer.enabled ? (
              <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] uppercase text-slate-600 dark:bg-slate-700 dark:text-slate-200">
                disabled
              </span>
            ) : null}
          </div>
          <div className="truncate font-mono text-[11px] text-slate-500 dark:text-slate-400">
            {printer.host}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <span
            aria-label={STATUS_LABEL[printer.lastStatus]}
            className={`inline-block h-2.5 w-2.5 rounded-full ${STATUS_DOT[printer.lastStatus]}`}
          />
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
            {STATUS_LABEL[printer.lastStatus]}
          </span>
        </div>
      </header>

      {printer.lastError ? (
        <p className="flex items-start gap-1.5 rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] text-rose-700 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          <span className="break-all">{printer.lastError}</span>
        </p>
      ) : null}

      {printer.supplies.length > 0 ? (
        <section>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Supplies
          </div>
          <ul className="space-y-1">
            {printer.supplies.map((s, i) => (
              <li key={i} className="text-xs">
                <div className="flex justify-between">
                  <span className="truncate">{s.name}</span>
                  <span className="font-mono text-slate-500 dark:text-slate-400">{s.percent}%</span>
                </div>
                <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                  <div
                    className={`h-full ${COLORANT_BAR[s.colorant] ?? COLORANT_BAR.other}`}
                    style={{ width: `${s.percent}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {printer.inputs.length > 0 ? (
        <section>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Paper trays
          </div>
          <ul className="space-y-1">
            {printer.inputs.map((t, i) => (
              <li key={i} className="text-xs">
                <div className="flex justify-between">
                  <span className="truncate">{t.name}</span>
                  <span className="font-mono text-slate-500 dark:text-slate-400">{t.percent}%</span>
                </div>
                <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                  <div
                    className={`h-full ${
                      t.percent < 10 ? "bg-rose-500" : t.percent < 25 ? "bg-amber-500" : "bg-emerald-500"
                    }`}
                    style={{ width: `${t.percent}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {printer.alerts.length > 0 ? (
        <section className="text-[11px] text-slate-600 dark:text-slate-300">
          <div className="mb-0.5 font-semibold uppercase tracking-wide text-slate-500">Alerts</div>
          <ul className="space-y-0.5">
            {printer.alerts.map((a, i) => (
              <li key={i}>
                <span
                  className={`mr-1 inline-block rounded px-1 py-0 text-[9px] uppercase ${
                    a.severity === "critical"
                      ? "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-200"
                      : a.severity === "warning"
                        ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200"
                        : "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300"
                  }`}
                >
                  {a.severity}
                </span>
                {a.description}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {printer.kind === "fiery" ? (
        <section className="rounded-md border border-slate-300 px-2 py-1 text-[11px] dark:border-slate-800">
          <span className="text-slate-500 dark:text-slate-400">Active jobs: </span>
          <span className="font-medium">
            {printer.fieryQueueDepth === null ? "—" : printer.fieryQueueDepth}
          </span>
        </section>
      ) : null}

      <footer className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
        <span>
          {printer.lastCheckedAt
            ? `checked ${timeAgo(printer.lastCheckedAt)}`
            : "never checked"}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void doPoll()}
            disabled={polling}
            className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            <RefreshCw className={`h-3 w-3 ${polling ? "animate-spin" : ""}`} aria-hidden />
            {polling ? "Polling…" : "Refresh"}
          </button>
          {canAdmin ? (
            <>
              <button
                type="button"
                onClick={onEdit}
                aria-label={`Edit ${printer.name}`}
                className="text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={onDelete}
                aria-label={`Delete ${printer.name}`}
                className="text-rose-600 hover:text-rose-700"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </>
          ) : null}
        </div>
      </footer>
    </li>
  );
}

function PrinterFormDrawer({
  mode,
  printer,
  onClose,
  onError,
}: {
  mode: "create" | "edit";
  printer?: Printer;
  onClose: () => void;
  onError: (msg: string) => void;
}) {
  const [name, setName] = useState(printer?.name ?? "");
  const [host, setHost] = useState(printer?.host ?? "");
  const [kind, setKind] = useState<PrinterKind>(printer?.kind ?? "ricoh");
  const [snmpPort, setSnmpPort] = useState<number>(printer?.snmpPort ?? 161);
  const [snmpVersion, setSnmpVersion] = useState<string>(printer?.snmpVersion ?? "");
  const [snmpCommunity, setSnmpCommunity] = useState<string>(printer?.snmpCommunity ?? "");
  const [fieryApiUrl, setFieryApiUrl] = useState<string>(printer?.fieryApiUrl ?? "");
  const [fieryApiKey, setFieryApiKey] = useState<string>(printer?.fieryApiKey ?? "");
  const [enabled, setEnabled] = useState<boolean>(printer?.enabled ?? true);
  const [notes, setNotes] = useState<string>(printer?.notes ?? "");
  const [busy, startTransition] = useTransition();
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<
    { ok: boolean; message: string } | null
  >(null);

  async function runTest() {
    if (testing || busy) return;
    setTestResult(null);
    setTesting(true);
    try {
      const r = await fetch("/api/printers/test", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          host: host.trim(),
          port: snmpPort,
          version: snmpVersion === "" ? undefined : snmpVersion,
          community: snmpCommunity.trim() === "" ? undefined : snmpCommunity.trim(),
        }),
      });
      let parsed: { ok?: boolean; message?: string } = {};
      try {
        parsed = (await r.json()) as typeof parsed;
      } catch {
        /* fall through to status fallback */
      }
      if (!r.ok) {
        setTestResult({ ok: false, message: parsed.message ?? `Request failed (${r.status})` });
        return;
      }
      setTestResult({
        ok: Boolean(parsed.ok),
        message: parsed.message ?? (parsed.ok ? "OK" : "Failed"),
      });
    } catch (err) {
      setTestResult({ ok: false, message: (err as Error).message || String(err) });
    } finally {
      setTesting(false);
    }
  }

  function save() {
    startTransition(async () => {
      const body = {
        name: name.trim(),
        host: host.trim(),
        kind,
        snmpPort,
        snmpVersion: snmpVersion === "" ? null : snmpVersion,
        snmpCommunity: snmpCommunity.trim() === "" ? null : snmpCommunity.trim(),
        fieryApiUrl: fieryApiUrl.trim() === "" ? null : fieryApiUrl.trim(),
        fieryApiKey: fieryApiKey.trim() === "" ? null : fieryApiKey.trim(),
        notes: notes.trim() === "" ? null : notes.trim(),
        ...(mode === "edit" ? { enabled } : {}),
      };
      const url = mode === "create" ? "/api/printers" : `/api/printers/${printer!.id}`;
      const method = mode === "create" ? "POST" : "PATCH";
      const r = await fetch(url, {
        method,
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        onError(`${mode === "create" ? "Create" : "Update"} failed (${r.status})`);
        return;
      }
      onClose();
    });
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      className="fixed inset-0 z-[1000] flex items-start justify-end bg-black/40 p-4"
    >
      <aside
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-md flex-col overflow-y-auto rounded-md border border-slate-300 bg-white p-5 shadow-xl dark:border-slate-700 dark:bg-slate-900"
      >
        <header className="mb-4 flex items-start justify-between">
          <h2 className="text-lg font-semibold">
            {mode === "create" ? "Add printer" : `Edit ${printer?.name ?? ""}`}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 hover:bg-slate-100 dark:hover:bg-slate-800">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="space-y-3 text-sm">
          <Field label="Name">
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              className="w-full rounded-md border border-slate-300 px-2 py-1.5 dark:border-slate-700 dark:bg-slate-950"
            />
          </Field>
          <Field label="Host / IP">
            <input
              required
              value={host}
              onChange={(e) => setHost(e.target.value)}
              maxLength={255}
              placeholder="192.168.1.50 or printer.local"
              className="w-full rounded-md border border-slate-300 px-2 py-1.5 dark:border-slate-700 dark:bg-slate-950"
            />
          </Field>
          <Field label="Kind">
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as PrinterKind)}
              className="w-full rounded-md border border-slate-300 px-2 py-1.5 dark:border-slate-700 dark:bg-slate-950"
            >
              {PRINTER_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </Field>

          <fieldset className="rounded-md border border-slate-300 p-3 dark:border-slate-700">
            <legend className="px-1 text-xs uppercase tracking-wide text-slate-500">SNMP</legend>
            <div className="space-y-2">
              <Field label="Port">
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={snmpPort}
                  onChange={(e) => setSnmpPort(parseInt(e.target.value, 10) || 161)}
                  className="w-full rounded-md border border-slate-300 px-2 py-1.5 dark:border-slate-700 dark:bg-slate-950"
                />
              </Field>
              <Field label="Version (blank = global default)">
                <select
                  value={snmpVersion}
                  onChange={(e) => setSnmpVersion(e.target.value)}
                  className="w-full rounded-md border border-slate-300 px-2 py-1.5 dark:border-slate-700 dark:bg-slate-950"
                >
                  <option value="">(use default)</option>
                  {SNMP_VERSIONS.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Community (blank = global default)">
                <input
                  value={snmpCommunity}
                  onChange={(e) => setSnmpCommunity(e.target.value)}
                  maxLength={64}
                  className="w-full rounded-md border border-slate-300 px-2 py-1.5 dark:border-slate-700 dark:bg-slate-950"
                />
              </Field>
            </div>
          </fieldset>

          {kind === "fiery" ? (
            <fieldset className="rounded-md border border-slate-300 p-3 dark:border-slate-700">
              <legend className="px-1 text-xs uppercase tracking-wide text-slate-500">Fiery REST</legend>
              <div className="space-y-2">
                <Field label="API base URL">
                  <input
                    value={fieryApiUrl}
                    onChange={(e) => setFieryApiUrl(e.target.value)}
                    placeholder="https://fiery.local"
                    className="w-full rounded-md border border-slate-300 px-2 py-1.5 dark:border-slate-700 dark:bg-slate-950"
                  />
                </Field>
                <Field label="API key">
                  <input
                    type="password"
                    value={fieryApiKey}
                    onChange={(e) => setFieryApiKey(e.target.value)}
                    className="w-full rounded-md border border-slate-300 px-2 py-1.5 dark:border-slate-700 dark:bg-slate-950"
                  />
                </Field>
              </div>
            </fieldset>
          ) : null}

          {mode === "edit" ? (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              Enabled (poll on the background tick)
            </label>
          ) : null}

          <Field label="Notes">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={500}
              rows={3}
              className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950"
            />
          </Field>
        </div>

        {testResult ? (
          <p
            role="status"
            className={`mt-3 rounded-md border px-3 py-2 text-xs ${
              testResult.ok
                ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                : "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300"
            }`}
          >
            {testResult.message}
          </p>
        ) : null}

        <div className="mt-auto flex justify-end gap-2 border-t border-slate-300 pt-4 dark:border-slate-800">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={runTest}
            disabled={busy || testing || !host.trim()}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            {testing ? "Testing…" : "Test connection"}
          </button>
          <button
            type="button"
            onClick={save}
            disabled={busy || testing || !name.trim() || !host.trim()}
            className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {busy ? "Saving…" : mode === "create" ? "Create" : "Save"}
          </button>
        </div>
      </aside>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs text-slate-500 dark:text-slate-400">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (diffMs < 60_000) return "just now";
  const min = Math.floor(diffMs / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}
