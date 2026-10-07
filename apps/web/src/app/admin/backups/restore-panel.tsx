"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, FileDiff, RotateCcw, Upload } from "lucide-react";
import {
  RESTORE_CONFIRM_PHRASE,
  type BackupDiffReport,
  type BackupOperation,
  type BackupRestoreResult,
  type BackupSummary,
} from "@church/shared";
import { LocalDateTime } from "@/components/local-date-time";
import { api, formatBytes, formatCount, post, useOperation } from "./client-api";
import { KindBadge } from "./backups-panel";
import { DiffReport } from "./diff-report";
import { ErrorNote, OperationProgress } from "./operation-progress";

const WHEN: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };

/** A multipart upload with progress (fetch cannot report upload progress). */
function uploadBackup(file: File, onProgress: (fraction: number) => void): Promise<{ backupId: string; operationId: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/v1/admin/backups/upload");
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onerror = () => reject(new Error("The upload was interrupted."));
    xhr.onload = () => {
      let body: { message?: unknown; backupId?: string; operationId?: string } = {};
      try {
        body = JSON.parse(xhr.responseText) as typeof body;
      } catch {
        // not JSON
      }
      if (xhr.status >= 200 && xhr.status < 300 && body.backupId && body.operationId) {
        resolve({ backupId: body.backupId, operationId: body.operationId });
      } else {
        reject(new Error(typeof body.message === "string" ? body.message : `The upload failed (${xhr.status}).`));
      }
    };
    const form = new FormData();
    form.append("file", file, file.name);
    xhr.send(form);
  });
}

export function RestorePanel({
  initialBackups,
  initialSelected,
  runningOperation,
}: {
  initialBackups: BackupSummary[];
  initialSelected: string | null;
  runningOperation: BackupOperation | null;
}) {
  const [backups, setBackups] = useState(initialBackups);
  const [selected, setSelected] = useState<string | null>(initialSelected);
  const [report, setReport] = useState<BackupDiffReport | null>(null);
  const [result, setResult] = useState<BackupRestoreResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"idle" | "uploading" | "importing" | "comparing" | "restoring">("idle");
  const [uploadFraction, setUploadFraction] = useState(0);
  const [phrase, setPhrase] = useState("");
  const [safety, setSafety] = useState(true);
  const [acceptSecret, setAcceptSecret] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const ready = useMemo(() => backups.filter((b) => b.status === "ready"), [backups]);
  const chosen = ready.find((b) => b.id === selected) ?? null;

  const refresh = async (): Promise<BackupSummary[]> => {
    const list = await api<BackupSummary[]>("");
    setBackups(list);
    return list;
  };

  const { op, lost, track } = useOperation<unknown>(async (finished) => {
    if (finished.status === "failed") {
      setError(finished.error ?? "That did not work.");
      setMode("idle");
      if (finished.kind === "import") await refresh().catch(() => undefined);
      return;
    }
    if (finished.kind === "import") {
      const list = await refresh().catch(() => backups);
      const made = list.find((b) => b.id === finished.backupId);
      if (made) setSelected(made.id);
      setMode("idle");
    } else if (finished.kind === "compare") {
      setReport(finished.result as BackupDiffReport);
      setMode("idle");
    } else if (finished.kind === "restore") {
      setResult(finished.result as BackupRestoreResult);
      setMode("idle");
      await refresh().catch(() => undefined);
    }
  });

  // Pick up an operation that was already running when the page loaded (a reload during a restore, say).
  useEffect(() => {
    if (!runningOperation) return;
    if (runningOperation.kind === "restore") setMode("restoring");
    else if (runningOperation.kind === "compare") setMode("comparing");
    else if (runningOperation.kind === "import") setMode("importing");
    else return;
    if (runningOperation.backupId) setSelected(runningOperation.backupId);
    track(runningOperation.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const busy = mode !== "idle";

  function choose(id: string) {
    setSelected(id);
    setReport(null);
    setResult(null);
    setError(null);
    setPhrase("");
    setAcceptSecret(false);
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    setReport(null);
    setResult(null);
    setMode("uploading");
    setUploadFraction(0);
    try {
      const started = await uploadBackup(file, setUploadFraction);
      setMode("importing");
      track(started.operationId);
    } catch (e) {
      setError((e as Error).message);
      setMode("idle");
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function compare() {
    if (!chosen) return;
    setError(null);
    setReport(null);
    setResult(null);
    setMode("comparing");
    try {
      const started = await post<{ operationId: string }>(`/${chosen.id}/compare`, undefined, "Couldn't start the comparison");
      track(started.operationId);
    } catch (e) {
      setError((e as Error).message);
      setMode("idle");
    }
  }

  async function restore() {
    if (!chosen || !report) return;
    if (!confirm(`Restore "${chosen.name}" now? Everything changed since it was made will be lost${safety ? " (a safety backup of the current data is made first)" : ", and no safety backup is made"}.`)) return;
    setError(null);
    setMode("restoring");
    try {
      const started = await post<{ operationId: string }>(
        `/${chosen.id}/restore`,
        { confirm: RESTORE_CONFIRM_PHRASE, safetyBackup: safety, acceptSecretMismatch: acceptSecret },
        "Couldn't start the restore",
      );
      track(started.operationId);
    } catch (e) {
      setError((e as Error).message);
      setMode("idle");
    }
  }

  const canRestore =
    !!chosen && !!report && report.compatibility.ok && phrase === RESTORE_CONFIRM_PHRASE && (!report.secretMismatch || acceptSecret) && !busy;

  return (
    <div className="space-y-5">
      <div className="flex gap-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
        <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          A restore is a <strong>full rollback</strong>: the data is made to match the backup, so everything created or changed since is
          lost, uploaded files included. While it runs, changes are paused for everyone (a few minutes at most for a church-sized site).
          Compare first to see exactly what would change. By default a safety backup of the current data is made first, so a restore can be
          undone by restoring that.
        </p>
      </div>

      {mode === "restoring" && op && op.status === "running" ? (
        <div className="space-y-2" data-testid="restore-running">
          <OperationProgress op={op} title="Restoring - changes are paused for everyone" />
          <p className="text-xs text-slate-500">Keep this page open. If something goes wrong the data is left exactly as it was.</p>
        </div>
      ) : null}
      {lost ? <ErrorNote>{lost}</ErrorNote> : null}
      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {result ? (
        <section className="rounded-md border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200" data-testid="restore-done">
          <h2 className="text-base font-semibold">Restored</h2>
          <p className="mt-1">
            {formatCount(result.rowsAdded)} rows brought back, {formatCount(result.rowsRemoved)} deleted, {formatCount(result.rowsChanged)} put back as they were;{" "}
            {formatCount(result.filesRestored)} files restored, {formatCount(result.filesRemoved)} removed.
          </p>
          {result.safetyBackupId ? (
            <p className="mt-1">
              The data as it was just before is in the list as a <strong>safety copy</strong>. To undo this restore, restore that.
            </p>
          ) : null}
          {result.warnings.length > 0 ? (
            <ul className="mt-2 list-disc pl-5">
              {result.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          ) : null}
          <p className="mt-2">Search is being rebuilt in the background. Reload the page to see the restored data; you may need to sign in again.</p>
          <button type="button" onClick={() => window.location.assign("/admin/backups?tab=backups")} className="mt-3 rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800">
            Reload
          </button>
        </section>
      ) : (
        <>
          <section className="rounded-md border border-slate-300 p-4 dark:border-slate-800">
            <h2 className="text-base font-semibold">1. Choose a backup</h2>
            {ready.length === 0 ? (
              <p className="mt-2 text-sm text-slate-500">
                There are no backups to restore from yet. Make one in the <Link href="/admin/backups" className="text-brand-600 hover:underline dark:text-brand-400">Backups</Link> tab, or upload a file below.
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-slate-200 rounded-md border border-slate-200 dark:divide-slate-800 dark:border-slate-800" role="radiogroup" aria-label="Backups">
                {ready.map((b) => (
                  <li key={b.id}>
                    <label className={`flex cursor-pointer items-start gap-3 px-3 py-2 text-sm hover:bg-slate-50 dark:hover:bg-slate-900 ${selected === b.id ? "bg-brand-50 dark:bg-brand-950/30" : ""}`}>
                      <input type="radio" name="backup" className="mt-1" checked={selected === b.id} onChange={() => choose(b.id)} disabled={busy} />
                      <span className="flex-1">
                        <span className="font-medium">{b.name}</span>{" "}
                        <KindBadge kind={b.kind} />
                        <span className="block text-xs text-slate-500">
                          <LocalDateTime value={b.createdAt} options={WHEN} /> - {formatBytes(b.sizeBytes)} - {formatCount(b.totalRows)} rows
                          {b.includeFiles ? `, ${formatCount(b.fileCount)} files` : ", no files"}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-3 rounded-md border border-dashed border-slate-300 p-3 dark:border-slate-700">
              <div className="flex flex-wrap items-center gap-3">
                <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-900">
                  <Upload aria-hidden className="h-4 w-4" /> Upload a backup file...
                  <input
                    ref={fileInput}
                    type="file"
                    accept=".gz,.tgz,.tar.gz,application/gzip,application/x-gzip"
                    className="sr-only"
                    disabled={busy}
                    onChange={(e) => void onFile(e.target.files?.[0])}
                    data-testid="backup-file-input"
                  />
                </label>
                <span className="text-xs text-slate-500">A .tar.gz downloaded from Backups (on this or another installation). It is checked, then listed above.</span>
              </div>
              {mode === "uploading" ? (
                <div className="mt-2" role="status">
                  <div className="h-1.5 overflow-hidden rounded bg-brand-100 dark:bg-brand-900">
                    <div className="h-full bg-brand-600 transition-all" style={{ width: `${Math.round(uploadFraction * 100)}%` }} />
                  </div>
                  <p className="mt-1 text-xs text-slate-500">Uploading... {Math.round(uploadFraction * 100)}% (large files take a while: keep this page open)</p>
                </div>
              ) : null}
              {mode === "importing" && op && op.status === "running" ? (
                <div className="mt-2">
                  <OperationProgress op={op} title="Checking the uploaded file" />
                </div>
              ) : null}
            </div>
          </section>

          <section className="rounded-md border border-slate-300 p-4 dark:border-slate-800">
            <h2 className="text-base font-semibold">2. See what would change</h2>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">Nothing is changed by this step: it compares the backup with the data as it is right now.</p>
            <button
              type="button"
              onClick={() => void compare()}
              disabled={!chosen || busy}
              className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-brand-600 px-3.5 py-1.5 text-sm font-medium text-brand-700 hover:bg-brand-50 disabled:opacity-50 dark:text-brand-300 dark:hover:bg-brand-950/40"
            >
              <FileDiff aria-hidden className="h-4 w-4" /> {mode === "comparing" ? "Comparing..." : "Compare with the current data"}
            </button>
            {mode === "comparing" && op && op.status === "running" ? (
              <div className="mt-3">
                <OperationProgress op={op} title="Comparing" />
              </div>
            ) : null}
            {report ? (
              <div className="mt-4">
                <DiffReport report={report} />
              </div>
            ) : null}
          </section>

          {report && chosen ? (
            <section className="rounded-md border border-rose-300 p-4 dark:border-rose-800" data-testid="restore-confirm">
              <h2 className="text-base font-semibold text-rose-800 dark:text-rose-300">3. Restore</h2>
              {!report.compatibility.ok ? (
                <p className="mt-1 text-sm text-rose-700 dark:text-rose-300">This backup cannot be restored here: see the problems above.</p>
              ) : (
                <div className="mt-2 space-y-3 text-sm">
                  <label className="flex items-start gap-2">
                    <input type="checkbox" className="mt-1" checked={safety} onChange={(e) => setSafety(e.target.checked)} disabled={busy} />
                    <span>
                      <strong>Make a safety backup of the current data first</strong> (recommended). It is kept in the list as a &quot;Safety copy&quot; so this restore can be undone.
                    </span>
                  </label>
                  {report.secretMismatch ? (
                    <label className="flex items-start gap-2">
                      <input type="checkbox" className="mt-1" checked={acceptSecret} onChange={(e) => setAcceptSecret(e.target.checked)} disabled={busy} />
                      <span>
                        Go ahead although this backup was made with a different AUTH_SECRET: saved SMTP, OAuth and device passwords will not decrypt and must be entered again.
                      </span>
                    </label>
                  ) : null}
                  <label className="block">
                    <span className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                      Type <code className="font-mono">{RESTORE_CONFIRM_PHRASE}</code> to confirm
                    </span>
                    <input
                      value={phrase}
                      onChange={(e) => setPhrase(e.target.value)}
                      autoComplete="off"
                      className="mt-1 w-full max-w-xs rounded-md border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-sm dark:border-slate-700 dark:bg-slate-900"
                      disabled={busy}
                      data-testid="restore-phrase"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => void restore()}
                    disabled={!canRestore}
                    className="inline-flex items-center gap-1.5 rounded-md bg-rose-600 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-40"
                    data-testid="restore-button"
                  >
                    <RotateCcw aria-hidden className="h-4 w-4" /> Restore this backup
                  </button>
                </div>
              )}
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

