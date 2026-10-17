"use client";

import { useState } from "react";
import { HandHelping } from "lucide-react";

/**
 * "I'm on it" for an open incident: stops reminders and escalation, and does not resolve anything. The caller learns the
 * time it was taken so the row can say so without waiting for a refetch.
 */
export function AcknowledgeButton({ incidentId, onAcknowledged }: { incidentId: string; onAcknowledged: (at: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function take() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/monitors/incidents/${encodeURIComponent(incidentId)}/ack`, { method: "POST", credentials: "same-origin" });
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as { message?: string } | null;
        setErr(body?.message ?? "Couldn't acknowledge it.");
        return;
      }
      const row = (await r.json()) as { acknowledgedAt?: string | null };
      onAcknowledged(row.acknowledgedAt ?? new Date().toISOString());
    } catch {
      setErr("Couldn't reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={() => void take()}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-2.5 py-1 text-xs hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
        data-testid="ack-incident"
      >
        <HandHelping className="h-3.5 w-3.5" aria-hidden /> {busy ? "Saving..." : "Acknowledge"}
      </button>
      {err ? <span className="text-rose-600 dark:text-rose-400">{err}</span> : null}
    </span>
  );
}
