"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { CloudDownload, CloudUpload, PlugZap, Settings as SettingsIcon } from "lucide-react";
import type { BackupOffsiteObject, BackupOffsiteStatus, BackupOffsiteTest, BackupOperation } from "@church/shared";
import { LocalDateTime } from "@/components/local-date-time";
import { api, formatBytes, post, useOperation } from "./client-api";
import { ErrorNote, OperationProgress } from "./operation-progress";

const WHEN: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
const button =
  "inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-900";

function stateLine(s: BackupOffsiteStatus): { text: string; tone: "ok" | "warn" | "off" } {
  if (!s.configured) return { text: s.missing ? `Offsite copies are not set up yet: ${s.missing} is missing.` : "Offsite copies are not set up yet.", tone: "off" };
  if (s.problem) return { text: s.problem, tone: "warn" };
  if (!s.enabled) return { text: "Set up, but switched off. Backups are not being copied.", tone: "off" };
  if (s.failing > 0 && s.lastError) return { text: "Copying is switched on, but the last attempt failed.", tone: "warn" };
  return { text: "Copying is switched on. Each scheduled backup is copied to the bucket after it is made.", tone: "ok" };
}

export function OffsitePanel({
  initialStatus,
  runningOperation,
}: {
  initialStatus: BackupOffsiteStatus | null;
  runningOperation: BackupOperation | null;
}) {
  const [status, setStatus] = useState(initialStatus);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [test, setTest] = useState<BackupOffsiteTest | null>(null);
  const [testing, setTesting] = useState(false);
  const [objects, setObjects] = useState<BackupOffsiteObject[] | null>(null);
  const [listing, setListing] = useState(false);
  const [broughtBack, setBroughtBack] = useState<string | null>(null);

  const reload = async () => {
    try {
      setStatus(await api<BackupOffsiteStatus>("/offsite"));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const { op, lost, track } = useOperation(async (finished) => {
    if (finished.status === "failed") {
      setError(finished.error ?? "That did not work.");
    } else if (finished.kind === "import") {
      setNotice("The copy is back in your backup list. It can be compared and restored from the Restore tab.");
      setBroughtBack((finished.result as { backupId?: string } | null)?.backupId ?? "");
    } else {
      const r = finished.result as { copied?: number; failed?: number; deleted?: number; warnings?: string[] } | null;
      setNotice(`Copied ${r?.copied ?? 0} backup${r?.copied === 1 ? "" : "s"}${r?.deleted ? `, removed ${r.deleted} older ${r.deleted === 1 ? "copy" : "copies"} from the bucket` : ""}.`);
      if (objects) void listObjects();
    }
    await reload();
  });

  // Follow a copy that was already running when the page opened.
  useEffect(() => {
    if (runningOperation && runningOperation.kind === "offsite") track(runningOperation.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const running = op?.status === "running";

  async function runTest() {
    setError(null);
    setTest(null);
    setTesting(true);
    try {
      setTest(await post<BackupOffsiteTest>("/offsite/test", undefined, "Couldn't run the test"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTesting(false);
    }
  }

  async function copyNow() {
    setError(null);
    setNotice(null);
    try {
      const started = await post<{ operationId: string }>("/offsite/copy", undefined, "Couldn't start the copy");
      track(started.operationId);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function listObjects() {
    setError(null);
    setListing(true);
    try {
      setObjects(await api<BackupOffsiteObject[]>("/offsite/objects", {}, "Couldn't read the bucket"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setListing(false);
    }
  }

  async function bringBack(o: BackupOffsiteObject) {
    setError(null);
    setNotice(null);
    setBroughtBack(null);
    try {
      const started = await post<{ operationId: string }>("/offsite/fetch", { key: o.key }, "Couldn't bring the copy back");
      track(started.operationId);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!status) {
    return <ErrorNote>The offsite settings could not be read.</ErrorNote>;
  }
  const line = stateLine(status);
  const canCopy = status.enabled && status.configured && !status.problem;
  const canList = status.configured && !status.problem;
  const toneClass =
    line.tone === "ok"
      ? "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200"
      : line.tone === "warn"
        ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
        : "border-slate-300 bg-slate-50 text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200";

  return (
    <div className="space-y-5">
      <section className="rounded-md border border-slate-300 p-4 dark:border-slate-800">
        <h2 className="text-base font-semibold">Offsite copies</h2>
        <p className="mt-1 max-w-3xl text-sm text-slate-600 dark:text-slate-400">
          Backups kept only on this installation are lost with it. This copies them to a second, separate bucket (any S3-compatible service:
          Backblaze B2, Amazon S3, Wasabi, a MinIO or Garage on another machine) and checks each copy after it is written.
        </p>
        <div className={`mt-3 rounded-md border px-3 py-2 text-sm ${toneClass}`} data-testid="offsite-state">
          {line.text}
        </div>

        {status.destination ? (
          <dl className="mt-3 grid max-w-3xl grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm" data-testid="offsite-destination">
            <dt className="text-slate-500 dark:text-slate-400">Bucket</dt>
            <dd className="break-all">{status.destination.bucket} at {status.destination.endpoint}</dd>
            <dt className="text-slate-500 dark:text-slate-400">Folder</dt>
            <dd>{status.destination.folder || "(top of the bucket)"}</dd>
            <dt className="text-slate-500 dark:text-slate-400">Keeps</dt>
            <dd>{status.keep > 0 ? `the newest ${status.keep} copies` : "every copy"}</dd>
            <dt className="text-slate-500 dark:text-slate-400">Last copy</dt>
            <dd>{status.lastCopyAt ? <LocalDateTime value={status.lastCopyAt} options={WHEN} /> : "none yet"}</dd>
            <dt className="text-slate-500 dark:text-slate-400">This site</dt>
            <dd>
              {status.copied} copied{status.pending > 0 ? `, ${status.pending} waiting` : ""}
              {status.failing > 0 ? `, ${status.failing} failed` : ""}
            </dd>
          </dl>
        ) : null}

        {status.lastError ? <div className="mt-3"><ErrorNote>The last copy failed: {status.lastError}</ErrorNote></div> : null}
        {status.warnings.map((w) => (
          <p key={w} className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">{w}</p>
        ))}

        <div className="mt-4 flex flex-wrap gap-2">
          <Link href="/admin/settings/backup" className={button}>
            <SettingsIcon aria-hidden className="h-4 w-4" /> {status.configured ? "Change settings" : "Set up"}
          </Link>
          <button type="button" onClick={() => void runTest()} disabled={testing || !status.configured} className={button}>
            <PlugZap aria-hidden className="h-4 w-4" /> {testing ? "Testing..." : "Test the connection"}
          </button>
          <button type="button" onClick={() => void copyNow()} disabled={!canCopy || running} className={button} data-testid="offsite-copy-now">
            <CloudUpload aria-hidden className="h-4 w-4" /> Copy waiting backups now
          </button>
        </div>

        {test ? (
          <p
            className={`mt-3 text-sm ${test.ok ? "text-emerald-700 dark:text-emerald-400" : "text-rose-700 dark:text-rose-400"}`}
            role="status"
            data-testid="offsite-test-result"
          >
            {test.message}
          </p>
        ) : null}
        {op && op.status === "running" ? (
          <div className="mt-3">
            <OperationProgress op={op} title={op.kind === "import" ? "Bringing the copy back" : "Copying offsite"} />
          </div>
        ) : null}
        {lost ? <div className="mt-3"><ErrorNote>{lost}</ErrorNote></div> : null}
        {error ? <div className="mt-3"><ErrorNote>{error}</ErrorNote></div> : null}
        {notice && !error ? (
          <p className="mt-3 text-sm text-emerald-700 dark:text-emerald-400">
            {notice}{" "}
            {broughtBack !== null ? (
              <Link href={broughtBack ? `/admin/backups?tab=restore&backup=${broughtBack}` : "/admin/backups?tab=restore"} className="underline">
                Open it in Restore
              </Link>
            ) : null}
          </p>
        ) : null}
      </section>

      <section>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold">Copies in the bucket</h2>
          <button type="button" onClick={() => void listObjects()} disabled={listing || !canList} className={button}>
            <CloudDownload aria-hidden className="h-4 w-4" /> {listing ? "Reading..." : objects ? "Refresh" : "Show what is in the bucket"}
          </button>
        </div>
        {objects === null ? (
          <p className="max-w-3xl text-sm text-slate-600 dark:text-slate-400">
            After a disaster, install this site again, enter the same bucket details under Settings &gt; Backups, and bring a copy back from
            here. It then appears in your backup list and is restored like any other. Restore it on an installation that uses the original
            AUTH_SECRET if saved passwords and tokens should keep working.
          </p>
        ) : objects.length === 0 ? (
          <p className="rounded-md border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500 dark:text-slate-400 dark:border-slate-700">
            Nothing from this site is in that folder yet.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-slate-300 dark:border-slate-800">
            <table className="w-full text-left text-sm" data-testid="offsite-table">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-900 dark:text-slate-400">
                <tr>
                  <th className="px-3 py-2">Copy</th>
                  <th className="px-3 py-2">Made</th>
                  <th className="px-3 py-2">Size</th>
                  <th className="px-3 py-2"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {objects.map((o) => (
                  <tr key={o.key}>
                    <td className="px-3 py-2 font-mono text-xs break-all">{o.name}</td>
                    <td className="px-3 py-2 text-xs text-slate-600 dark:text-slate-400">{o.createdAt ? <LocalDateTime value={o.createdAt} options={WHEN} /> : "-"}</td>
                    <td className="px-3 py-2 text-xs text-slate-600 dark:text-slate-400">{formatBytes(o.sizeBytes)}</td>
                    <td className="px-3 py-2 text-right">
                      {o.backupId ? (
                        <span className="text-xs text-slate-500 dark:text-slate-400">Also on this site</span>
                      ) : (
                        <button type="button" onClick={() => void bringBack(o)} disabled={running} className={button}>
                          Bring back
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 max-w-3xl text-xs text-slate-500 dark:text-slate-400">
          A copy is the same file as a download from the Backups tab: it holds password hashes, encrypted secrets and all your data, and it is
          not encrypted again. Use a private bucket, and a key that can only reach that bucket.
        </p>
      </section>
    </div>
  );
}
