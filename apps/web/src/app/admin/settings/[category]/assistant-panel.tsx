"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { CircleCheck, CircleX, Loader2 } from "lucide-react";
import type { AssistantLastTest, AssistantPrivacyAck, ReadinessItem } from "@church/shared";

interface Readiness {
  ready: boolean;
  enabled: boolean;
  items: ReadinessItem[];
  lastTest: AssistantLastTest | null;
  privacy: AssistantPrivacyAck | null;
  destination: string;
}
interface Usage {
  month: string;
  questions: number;
  cost: number;
  days: Array<{ day: string; questions: number; inputTokens: number; outputTokens: number; cost: number; errors: number }>;
}

/**
 * The assistant's setup above its settings: the checklist that must be green before the switch can be turned on (the API
 * enforces the same list), Test connection, the privacy notice to acknowledge, and this month's usage.
 */
export function AssistantPanel() {
  const [r, setR] = useState<Readiness | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [busy, setBusy] = useState<"test" | "ack" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [a, b] = await Promise.all([
      fetch("/api/v1/assistant/admin/readiness", { credentials: "same-origin", cache: "no-store" }),
      fetch("/api/v1/assistant/admin/usage", { credentials: "same-origin", cache: "no-store" }),
    ]);
    if (a.ok) setR((await a.json()) as Readiness);
    if (b.ok) setUsage((await b.json()) as Usage);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function post(path: string, what: "test" | "ack") {
    setBusy(what);
    setError(null);
    try {
      const res = await fetch(`/api/v1/assistant/admin/${path}`, { method: "POST", credentials: "same-origin" });
      if (!res.ok) setError(`Failed (${res.status})`);
      await load();
    } finally {
      setBusy(null);
    }
  }

  if (!r) return <p className="mt-6 text-sm text-slate-500 dark:text-slate-400">Loading…</p>;
  return (
    <section className="mt-6 space-y-4 rounded-md border border-slate-300 p-4 text-sm dark:border-slate-800" aria-labelledby="assistant-setup">
      <h2 id="assistant-setup" className="font-semibold">
        Before it can be switched on {r.enabled ? <span className="font-normal text-emerald-700 dark:text-emerald-300">(it is on)</span> : null}
      </h2>
      <ul className="space-y-1.5">
        {r.items.map((i) => (
          <li key={i.id} className="flex items-start gap-2">
            {i.ok ? (
              <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700 dark:text-emerald-400" aria-hidden />
            ) : (
              <CircleX className="mt-0.5 h-4 w-4 shrink-0 text-rose-700 dark:text-rose-400" aria-hidden />
            )}
            <span>
              <span className="font-medium">{i.label}</span>
              <span className="sr-only">{i.ok ? ": done" : ": not yet"}</span>
              {i.ok ? null : <span className="block text-xs text-slate-600 dark:text-slate-400">{i.detail}</span>}
            </span>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void post("test", "test")}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 dark:border-slate-700"
        >
          {busy === "test" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null} Test connection
        </button>
        {r.lastTest ? (
          <span className={r.lastTest.ok ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300"} role="status">
            {r.lastTest.ok ? "Passed" : "Failed"} ({new Date(r.lastTest.at).toLocaleString()}, {r.lastTest.model}): {r.lastTest.detail}
          </span>
        ) : (
          <span className="text-slate-500 dark:text-slate-400">Save the provider settings below first, then test.</span>
        )}
      </div>
      {error ? <p className="text-rose-700 dark:text-rose-300">{error}</p> : null}

      <div className="rounded-md bg-slate-50 p-3 dark:bg-slate-900">
        <h3 className="font-semibold">What is sent to {r.destination}</h3>
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-slate-700 dark:text-slate-300">
          <li>Each question, the earlier turns of that conversation, and the asker&apos;s name.</li>
          <li>
            What its lookups return, and only what the asker could see in the dashboard themselves: wiki pages, their own notes,
            tickets, and monitoring data such as device names, IP and MAC addresses, VLANs and service states.
          </li>
          <li>
            Never: passwords, keys, SNMP communities or other secrets, switch configurations, the audit log, backups, accounts and
            groups, or Planning Center people.
          </li>
          <li>The provider&apos;s own terms decide how long it keeps what it is sent and whether it trains on it. A model you run yourself keeps it on your network.</li>
        </ul>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          {r.privacy && r.privacy.destination === r.destination ? (
            <span className="text-emerald-700 dark:text-emerald-300">
              Acknowledged by {r.privacy.name} on {new Date(r.privacy.at).toLocaleDateString()}.
            </span>
          ) : (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void post("privacy", "ack")}
              className="rounded-md bg-brand-600 px-3 py-1.5 font-medium text-white hover:bg-brand-700 disabled:opacity-60"
            >
              I have read this, and the church accepts it
            </button>
          )}
        </div>
      </div>

      {usage ? (
        <p className="text-slate-700 dark:text-slate-300">
          This month ({usage.month}): {usage.questions} question{usage.questions === 1 ? "" : "s"}, cost {usage.cost.toFixed(2)}
          {usage.days.reduce((s, d) => s + d.errors, 0) ? `, ${usage.days.reduce((s, d) => s + d.errors, 0)} failed` : ""}.{" "}
          <Link href="/admin/assistant" className="text-brand-600 underline dark:text-brand-400">
            Usage in detail
          </Link>
        </p>
      ) : null}
    </section>
  );
}
