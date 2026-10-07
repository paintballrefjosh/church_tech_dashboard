"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Download, Pencil, RotateCcw, Trash2 } from "lucide-react";
import type { BackupOperation, BackupStorageInfo, BackupSummary } from "@church/shared";
import { LocalDateTime } from "@/components/local-date-time";
import { api, formatBytes, formatCount, KIND_LABEL, post, useOperation } from "./client-api";
import { ErrorNote, OperationProgress } from "./operation-progress";

const WHEN: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };

const KIND_STYLE: Record<string, string> = {
  manual: "border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300",
  scheduled: "border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-300",
  pre_restore: "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300",
  uploaded: "border-violet-300 bg-violet-50 text-violet-800 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-300",
};

export function KindBadge({ kind }: { kind: BackupSummary["kind"] }) {
  return (
    <span className={`inline-block rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${KIND_STYLE[kind] ?? KIND_STYLE.manual}`}>
      {KIND_LABEL[kind] ?? kind}
    </span>
  );
}

export function StatusBadge({ status }: { status: BackupSummary["status"] }) {
  if (status === "ready") return null;
  const style =
    status === "running"
      ? "border-brand-300 bg-brand-50 text-brand-800 dark:border-brand-800 dark:bg-brand-950 dark:text-brand-300"
      : "border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300";
  return <span className={`inline-block rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${style}`}>{status}</span>;
}

export function BackupsPanel({
  initialBackups,
  storage,
  runningOperation,
}: {
  initialBackups: BackupSummary[];
  storage: BackupStorageInfo | null;
  runningOperation: BackupOperation | null;
}) {
  const [backups, setBackups] = useState(initialBackups);
  const [name, setName] = useState("");
  const [includeFiles, setIncludeFiles] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setBackups(await api<BackupSummary[]>(""));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const { op, lost, track } = useOperation(async (finished) => {
    if (finished.status === "failed") setError(finished.error ?? "The backup failed.");
    else setNotice("Backup finished.");
    await refresh();
  });

  useEffect(() => {
    if (runningOperation && (runningOperation.kind === "backup" || runningOperation.kind === "import")) track(runningOperation.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // While something is being made, keep the list fresh too.
  const running = op?.status === "running";

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const started = await post<{ operationId: string }>("", { ...(name.trim() ? { name: name.trim() } : {}), includeFiles }, "Couldn't start the backup");
      setName("");
      track(started.operationId);
      void refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function download(b: BackupSummary) {
    setError(null);
    setBusyId(b.id);
    try {
      const link = await post<{ url: string }>(`/${b.id}/download-link`, undefined, "Couldn't prepare the download");
      // A plain navigation: the browser saves it (the response is an attachment) without leaving the page.
      window.location.assign(link.url);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function remove(b: BackupSummary) {
    if (!confirm(`Delete the backup "${b.name}"? It is removed from storage and cannot be recovered.`)) return;
    setError(null);
    setBusyId(b.id);
    try {
      await api(`/${b.id}`, { method: "DELETE" }, "Couldn't delete the backup");
      setBackups((prev) => prev.filter((x) => x.id !== b.id));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function saveName() {
    if (!renaming || !renaming.name.trim()) return;
    setError(null);
    try {
      const updated = await api<BackupSummary>(`/${renaming.id}`, { method: "PATCH", body: JSON.stringify({ name: renaming.name.trim() }) }, "Couldn't rename it");
      setBackups((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
      setRenaming(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="space-y-5">
      <section className="rounded-md border border-slate-300 p-4 dark:border-slate-800">
        <h2 className="text-base font-semibold">Back up now</h2>
        <p className="mt-1 max-w-3xl text-sm text-slate-600 dark:text-slate-400">
          A backup is one file holding all of this site&apos;s data (users, tickets, wiki, notes, settings, checklists, device and monitor
          configuration) and, if you tick the box, every uploaded file. It is kept here and you can download it to keep offline. It does not
          include the audit log, polled history or anything the system rebuilds by itself.
        </p>
        <form onSubmit={(e) => void create(e)} className="mt-3 flex flex-wrap items-end gap-3">
          <label className="min-w-[14rem] flex-1 text-sm">
            <span className="block text-xs font-medium text-slate-600 dark:text-slate-400">Name (optional)</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              placeholder="e.g. Before the Easter changes"
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
              disabled={running}
            />
          </label>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input type="checkbox" checked={includeFiles} onChange={(e) => setIncludeFiles(e.target.checked)} disabled={running} />
            Include uploaded files
          </label>
          <button
            type="submit"
            disabled={running}
            className="rounded-md bg-brand-600 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {running ? "Backing up..." : "Create backup"}
          </button>
        </form>
        {op && op.status === "running" ? (
          <div className="mt-3">
            <OperationProgress op={op} title={op.kind === "import" ? "Checking the uploaded file" : "Making a backup"} />
          </div>
        ) : null}
        {lost ? <div className="mt-3"><ErrorNote>{lost}</ErrorNote></div> : null}
        {error ? <div className="mt-3"><ErrorNote>{error}</ErrorNote></div> : null}
        {notice && !error ? <p className="mt-3 text-sm text-emerald-700 dark:text-emerald-400">{notice}</p> : null}
      </section>

      <section>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold">Backups</h2>
          {storage ? (
            <p className="text-xs text-slate-500">
              {storage.count} stored, {formatBytes(storage.totalBytes)}
              {storage.available ? "" : " - storage is not answering"}
            </p>
          ) : null}
        </div>
        {backups.length === 0 ? (
          <p className="rounded-md border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500 dark:border-slate-700">
            No backups yet. Make one above, or set up a schedule so it happens by itself.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-slate-300 dark:border-slate-800">
            <table className="w-full text-left text-sm" data-testid="backup-table">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-900 dark:text-slate-400">
                <tr>
                  <th className="px-3 py-2">Backup</th>
                  <th className="px-3 py-2">Made</th>
                  <th className="px-3 py-2">Size</th>
                  <th className="px-3 py-2">Contents</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {backups.map((b) => (
                  <tr key={b.id} className="align-top" data-backup-id={b.id}>
                    <td className="px-3 py-2">
                      {renaming?.id === b.id ? (
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            void saveName();
                          }}
                          className="flex items-center gap-2"
                        >
                          <input
                            autoFocus
                            value={renaming.name}
                            onChange={(e) => setRenaming({ id: b.id, name: e.target.value })}
                            maxLength={120}
                            className="w-full min-w-[12rem] rounded-md border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900"
                          />
                          <button type="submit" className="text-xs text-brand-600 hover:underline dark:text-brand-400">Save</button>
                          <button type="button" onClick={() => setRenaming(null)} className="text-xs text-slate-500 hover:underline">Cancel</button>
                        </form>
                      ) : (
                        <div className="font-medium">{b.name}</div>
                      )}
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                        <KindBadge kind={b.kind} />
                        <StatusBadge status={b.status} />
                        {b.scheduleName ? <span className="text-[11px] text-slate-500">from {b.scheduleName}</span> : null}
                      </div>
                      {b.error ? <p className={`mt-1 max-w-md text-xs ${b.status === "failed" ? "text-rose-600 dark:text-rose-400" : "text-amber-700 dark:text-amber-400"}`}>{b.error}</p> : null}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-600 dark:text-slate-400">
                      <LocalDateTime value={b.createdAt} options={WHEN} />
                      <div className="text-slate-500">{b.createdBy ? b.createdBy.displayName ?? b.createdBy.email : b.kind === "scheduled" ? "Automatic" : ""}</div>
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-600 dark:text-slate-400">{formatBytes(b.sizeBytes)}</td>
                    <td className="px-3 py-2 text-xs text-slate-600 dark:text-slate-400">
                      {b.status === "ready" ? (
                        <>
                          {formatCount(b.totalRows)} rows
                          <div>{b.includeFiles ? `${formatCount(b.fileCount)} files (${formatBytes(b.fileBytes)})` : "no uploaded files"}</div>
                        </>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {b.status === "ready" ? (
                        <div className="flex flex-wrap justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => void download(b)}
                            disabled={busyId === b.id}
                            className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-900"
                          >
                            <Download aria-hidden className="h-3.5 w-3.5" /> Download
                          </button>
                          <Link
                            href={`/admin/backups?tab=restore&backup=${b.id}`}
                            className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-900"
                          >
                            <RotateCcw aria-hidden className="h-3.5 w-3.5" /> Restore...
                          </Link>
                          <button
                            type="button"
                            onClick={() => setRenaming({ id: b.id, name: b.name })}
                            aria-label={`Rename ${b.name}`}
                            className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-900"
                          >
                            <Pencil aria-hidden className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ) : null}
                      {b.status !== "running" ? (
                        <button
                          type="button"
                          onClick={() => void remove(b)}
                          disabled={busyId === b.id}
                          aria-label={`Delete ${b.name}`}
                          className="mt-1.5 inline-flex items-center gap-1 rounded-md border border-rose-300 px-2 py-1 text-xs text-rose-700 hover:bg-rose-50 disabled:opacity-50 dark:border-rose-800 dark:text-rose-300 dark:hover:bg-rose-950"
                        >
                          <Trash2 aria-hidden className="h-3.5 w-3.5" /> Delete
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 max-w-3xl text-xs text-slate-500">
          Backups contain password hashes and encrypted secrets. Keep downloaded files somewhere private. They can only be restored on an
          installation that uses the same AUTH_SECRET if you want saved SMTP, OAuth and device passwords to keep working.
        </p>
      </section>
    </div>
  );
}
