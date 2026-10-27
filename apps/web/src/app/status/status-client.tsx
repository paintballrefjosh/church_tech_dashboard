"use client";

import { useCallback, useEffect, useState } from "react";
import { CircleCheck, CircleHelp, CircleX, TriangleAlert, Wrench, Zap } from "lucide-react";
import { STATUS_OVERALL_TEXT, type PublicStatusPage, type StatusOverall } from "@church/shared";
import { LocalDateTime } from "@/components/local-date-time";

const POLL_MS = 30_000;
const WHEN: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };

const BANNER: Record<StatusOverall, string> = {
  ok: "border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100",
  degraded: "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100",
  outage: "border-rose-300 bg-rose-50 text-rose-950 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-100",
  unknown: "border-slate-300 bg-slate-50 text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200",
};

/** The signed-in page's items carry an id too; both pages render the same fields. */
type Item = PublicStatusPage["items"][number];

function stateWords(item: Item): { label: string; hint: string | null } {
  switch (item.state) {
    case "up":
      return { label: "Working", hint: null };
    case "down":
      return { label: "Down", hint: item.acknowledged ? "Someone is looking into it." : null };
    case "flapping":
      return { label: "Unstable", hint: "It keeps dropping out and coming back." };
    default:
      return { label: "Not known yet", hint: null };
  }
}

function StateIcon({ state }: { state: Item["state"] }) {
  const cls = "h-6 w-6 shrink-0";
  if (state === "up") return <CircleCheck aria-hidden className={`${cls} text-emerald-700 dark:text-emerald-400`} />;
  if (state === "down") return <CircleX aria-hidden className={`${cls} text-rose-600 dark:text-rose-400`} />;
  if (state === "flapping") return <TriangleAlert aria-hidden className={`${cls} text-amber-700 dark:text-amber-400`} />;
  return <CircleHelp aria-hidden className={`${cls} text-slate-500 dark:text-slate-400`} />;
}

/** `source` is where it refreshes from: the signed-in page's proxy, or the public copy (no sign-in). */
export function StatusClient({ initial, source = "/api/status" }: { initial: PublicStatusPage | null; source?: string }) {
  const [page, setPage] = useState(initial);
  const [stale, setStale] = useState(initial === null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(source, { credentials: "same-origin", cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      setPage((await r.json()) as PublicStatusPage);
      setStale(false);
    } catch {
      setStale(true);
    }
  }, [source]);

  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState !== "hidden") void refresh();
    }, POLL_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  if (!page) {
    return (
      <p className="rounded-md border border-slate-300 p-4 text-sm dark:border-slate-700" role="status">
        The status could not be loaded. It will try again in a moment.
      </p>
    );
  }

  return (
    <div className="space-y-5">
      {page.notice ? (
        <p className="flex items-start gap-2 rounded-md border border-sky-300 bg-sky-50 px-4 py-3 text-sm text-sky-950 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-100" data-testid="status-notice">
          <Zap aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{page.notice}</span>
        </p>
      ) : null}

      {page.maintenance.enabled ? (
        <p className="flex items-start gap-2 rounded-md border border-slate-300 bg-slate-50 px-4 py-3 text-sm dark:border-slate-700 dark:bg-slate-900" data-testid="status-maintenance">
          <Wrench aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Planned work is under way, so the people who look after these systems are not being alerted
            {page.maintenance.until ? (
              <>
                {" "}until <LocalDateTime value={page.maintenance.until} options={WHEN} />
              </>
            ) : null}
            .
          </span>
        </p>
      ) : null}

      <div className={`rounded-lg border px-5 py-4 ${BANNER[page.overall]}`} role="status" data-testid="status-overall" data-overall={page.overall}>
        <div className="text-xl font-semibold">{STATUS_OVERALL_TEXT[page.overall]}</div>
      </div>

      {page.items.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500 dark:text-slate-400 dark:border-slate-700">
          Nothing is listed here yet. An administrator chooses what appears when editing a monitor or a service group.
        </p>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-lg border border-slate-300 dark:divide-slate-800 dark:border-slate-800" data-testid="status-list">
          {page.items.map((item, i) => {
            const words = stateWords(item);
            return (
              <li key={`${i}:${item.name}`} className="flex items-center gap-3 px-4 py-3" data-state={item.state}>
                <StateIcon state={item.state} />
                <div className="min-w-0 flex-1">
                  <div className="text-base font-medium">{item.name}</div>
                  {words.hint ? <div className="text-sm text-slate-600 dark:text-slate-400">{words.hint}</div> : null}
                </div>
                <div className="text-right text-sm">
                  <div className="font-medium">{words.label}</div>
                  {item.since ? (
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      since <LocalDateTime value={item.since} options={WHEN} />
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-xs text-slate-500 dark:text-slate-400" aria-live="polite">
        {stale ? "Couldn't refresh just now. Showing what was last known. " : ""}
        Checked <LocalDateTime value={page.generatedAt} options={WHEN} />.
      </p>
    </div>
  );
}
