"use client";

import { useEffect, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Square,
  CircleCheck,
  AlertTriangle,
} from "lucide-react";

interface Health {
  configured: boolean;
  reachable: boolean;
  error: string | null;
}

// PP7's response shapes vary by version; we render best-effort and treat
// missing fields as "unknown".
interface Status {
  slide: {
    presentation_index?: { presentation_path?: string };
    text?: string;
    notes?: string;
  } | null;
  presentation: {
    name?: string;
    presentation?: { name?: string };
  } | null;
}

export function PropresenterClient() {
  const [health, setHealth] = useState<Health | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    const [h, s] = await Promise.all([
      fetch("/api/propresenter/health", { credentials: "same-origin", cache: "no-store" }),
      fetch("/api/propresenter/status", { credentials: "same-origin", cache: "no-store" }),
    ]);
    if (h.ok) setHealth((await h.json()) as Health);
    if (s.ok) setStatus((await s.json()) as Status);
  }

  useEffect(() => {
    void refresh();
    // Polling every second is fine for the live-control use case; PP7 reacts
    // to commands faster than that already. We can swap in a WebSocket
    // adapter later if this becomes a bottleneck.
    const t = setInterval(refresh, 1_000);
    return () => clearInterval(t);
  }, []);

  async function trigger(action: "next" | "previous" | "clear") {
    setErr(null);
    setBusy(true);
    try {
      const r = await fetch(`/api/propresenter/${action}`, {
        method: "POST",
        credentials: "same-origin",
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { message?: string };
        setErr(body.message ?? `Request failed (${r.status})`);
      }
    } finally {
      setBusy(false);
    }
  }

  if (health && !health.configured) {
    return (
      <p className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300">
        ProPresenter isn&apos;t configured. Set <code className="mx-0.5">propresenter.host</code> /{" "}
        <code className="mx-0.5">propresenter.port</code> (default 1025) and
        optionally <code className="mx-0.5">propresenter.password</code> in{" "}
        <a className="underline" href="/admin/settings/propresenter">Settings</a>.
      </p>
    );
  }

  const slideText = status?.slide?.text ?? "(no slide)";
  const presentationName =
    status?.presentation?.name ?? status?.presentation?.presentation?.name ?? "(no active presentation)";

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm">
        {health?.reachable ? (
          <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
            <CircleCheck className="h-4 w-4" aria-hidden /> Connected
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-rose-600 dark:text-rose-400">
            <AlertTriangle className="h-4 w-4" aria-hidden /> Unreachable
            {health?.error ? <span className="text-xs">— {health.error}</span> : null}
          </span>
        )}
      </div>

      <section className="rounded-md border border-slate-300 p-5 dark:border-slate-800">
        <div className="text-xs uppercase tracking-wide text-slate-500">Active presentation</div>
        <div className="mt-1 text-lg font-semibold">{presentationName}</div>
      </section>

      <section className="rounded-md border border-slate-300 p-5 dark:border-slate-800">
        <div className="text-xs uppercase tracking-wide text-slate-500">Current slide</div>
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-sm">
          {slideText}
        </pre>
      </section>

      <section className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy || !health?.reachable}
          onClick={() => void trigger("previous")}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          <ChevronLeft className="h-5 w-5" aria-hidden /> Previous
        </button>
        <button
          type="button"
          disabled={busy || !health?.reachable}
          onClick={() => void trigger("next")}
          className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          Next <ChevronRight className="h-5 w-5" aria-hidden />
        </button>
        <button
          type="button"
          disabled={busy || !health?.reachable}
          onClick={() => void trigger("clear")}
          className="inline-flex items-center gap-1.5 rounded-md border border-rose-300 px-4 py-2 text-sm text-rose-700 hover:bg-rose-50 disabled:opacity-50 dark:border-rose-700 dark:text-rose-300 dark:hover:bg-rose-900/30"
        >
          <Square className="h-4 w-4" aria-hidden /> Clear output
        </button>
        {err ? <span className="text-sm text-rose-600 dark:text-rose-400">{err}</span> : null}
      </section>
    </div>
  );
}
