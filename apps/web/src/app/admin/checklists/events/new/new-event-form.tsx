"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Save } from "lucide-react";
import type { ChecklistTemplate } from "@church/shared";

interface PcPlan {
  id: string;
  title: string;
  sortDate: string | null;
  serviceTypeId: string;
}

/**
 * Create-event form. Picks a template, sets a name + date, and optionally
 * links a Planning Center plan with auto-assign turned on. Template tasks
 * are snapshot-copied on the server when the event is created.
 */
export function NewEventForm({
  templates,
  pcConfigured,
  pcPlans,
}: {
  templates: ChecklistTemplate[];
  pcConfigured: boolean;
  pcPlans: PcPlan[];
}) {
  const router = useRouter();
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const [name, setName] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [pcPlanId, setPcPlanId] = useState("");
  const [autoAssign, setAutoAssign] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Derive serviceTypeId from the selected plan so the API can resolve the
  // PC nested URL (/service_types/<sid>/plans/<pid>).
  const selectedPlan = pcPlans.find((p) => p.id === pcPlanId);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const r = await fetch("/api/checklists/events", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          templateId,
          name: name.trim(),
          scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null,
          pcServiceTypeId: selectedPlan?.serviceTypeId ?? null,
          pcPlanId: pcPlanId || null,
          autoAssignFromPlan: !!pcPlanId && autoAssign,
        }),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { message?: string };
        setErr(b.message ?? `Create failed (${r.status})`);
        return;
      }
      const body = (await r.json()) as { event: { id: string } };
      router.push(`/checklists/${body.event.id}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-4 text-sm">
      <label className="block">
        <span className="text-xs text-slate-500">Template</span>
        <select
          required
          value={templateId}
          onChange={(e) => setTemplateId(e.target.value)}
          className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-950"
        >
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="text-xs text-slate-500">Event name</span>
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={200}
          placeholder="Sunday service — 2026-06-15"
          className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-950"
        />
      </label>

      <label className="block">
        <span className="text-xs text-slate-500">Date / time (optional)</span>
        <input
          type="datetime-local"
          value={scheduledAt}
          onChange={(e) => setScheduledAt(e.target.value)}
          className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-950"
        />
      </label>

      <fieldset className="rounded-md border border-slate-300 p-4 dark:border-slate-800">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Planning Center (optional)
        </legend>
        {!pcConfigured ? (
          <p className="text-xs text-slate-500">
            Planning Center isn&apos;t configured / reachable. Tasks will be unassigned by default;
            you can assign them manually after creation.
          </p>
        ) : pcPlans.length === 0 ? (
          <p className="text-xs text-slate-500">
            No upcoming PC plans found in the default service type. You can still leave this blank.
          </p>
        ) : (
          <div className="space-y-3">
            <label className="block">
              <span className="text-xs text-slate-500">Linked plan</span>
              <select
                value={pcPlanId}
                onChange={(e) => setPcPlanId(e.target.value)}
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-950"
              >
                <option value="">— None —</option>
                {pcPlans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                    {p.sortDate
                      ? ` — ${new Date(p.sortDate).toLocaleString(undefined, {
                          weekday: "short",
                          month: "short",
                          day: "numeric",
                        })}`
                      : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="inline-flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={autoAssign}
                onChange={(e) => setAutoAssign(e.target.checked)}
                disabled={!pcPlanId}
                className="h-4 w-4 rounded border-slate-300 text-brand-600 dark:border-slate-700 dark:bg-slate-900"
              />
              Auto-assign tasks by matching position name to PC team-members
            </label>
          </div>
        )}
      </fieldset>

      <div className="flex items-center gap-3 pt-2">
        <button
          type="submit"
          disabled={busy || !templateId || !name.trim()}
          className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-2 text-white hover:bg-brand-700 disabled:opacity-50"
        >
          <Save className="h-4 w-4" aria-hidden /> Create event
        </button>
        {err ? <span className="text-rose-600 dark:text-rose-400">{err}</span> : null}
      </div>
    </form>
  );
}
