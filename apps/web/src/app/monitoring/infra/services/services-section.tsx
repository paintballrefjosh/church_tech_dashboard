"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import type { ServiceInstance, ServiceTemplate } from "@church/shared";
import { usePoll } from "@/lib/use-poll";
import { ServiceFormModal, ServiceStatusPill, ago, cardKeys, formatMetric, metricLabel, primaryBtnCls, svcGet } from "./services-ui";

/** The host page's "Services" section: what runs on the host that is watched by a template, and a way to add one. */
export function ServicesSection({ targetId, canWrite }: { targetId: string; canWrite: boolean }) {
  const router = useRouter();
  const [list, setList] = useState<ServiceInstance[] | null>(null);
  const [templates, setTemplates] = useState<Map<string, ServiceTemplate>>(new Map());
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    const [l, t] = await Promise.all([
      svcGet<ServiceInstance[]>(`/instances?targetId=${targetId}`),
      templates.size ? Promise.resolve(null) : svcGet<ServiceTemplate[]>("/templates"),
    ]);
    if (l) setList(l);
    if (t) setTemplates(new Map(t.map((x) => [x.key, x])));
  }, [targetId, templates.size]);
  usePoll(load, 20_000);

  return (
    <section className="rounded-md border border-slate-300 p-4 dark:border-slate-800" aria-labelledby="services-heading" data-testid="host-services">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="services-heading" className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Services
        </h2>
        <Link href="/monitoring/infra/service-templates" className="text-xs text-brand-600 hover:underline dark:text-brand-400">
          Templates
        </Link>
        {canWrite ? (
          <button type="button" onClick={() => setAdding(true)} className={`${primaryBtnCls} ml-auto py-1 text-xs`}>
            <Plus className="h-3.5 w-3.5" aria-hidden /> Add service
          </button>
        ) : null}
      </div>
      {list === null ? (
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">Loading…</p>
      ) : list.length === 0 ? (
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          No services watched on this host. A template reads a service&apos;s own status (HAProxy, a database, Kea, Technitium ...) and alerts on its checks.
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-slate-200 dark:divide-slate-800">
          {list.map((s) => {
            const body = templates.get(s.templateKey)?.body ?? null;
            const keys = cardKeys(body, s.values, s.states).slice(0, 4);
            const breaching = s.checks.filter((c) => c.breaching);
            return (
              <li key={s.id} className="py-2">
                <Link href={`/monitoring/infra/${targetId}/services/${s.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded px-1 py-0.5 hover:bg-slate-50 dark:hover:bg-slate-800/60">
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {s.name} <ServiceStatusPill status={s.status} />
                    </span>
                    <span className="block text-xs text-slate-500 dark:text-slate-400">
                      {s.templateName} · checked {ago(s.lastPolledAt)}
                      {s.lastError ? ` · ${s.lastError}` : breaching.length ? ` · ${breaching.map((c) => c.text).join("; ")}` : ""}
                    </span>
                  </span>
                  <span className="flex flex-wrap gap-4">
                    {keys.map((k) => (
                      <span key={k} className="text-right">
                        <span className="block text-[11px] text-slate-500 dark:text-slate-400">{metricLabel(k, body?.metrics[k])}</span>
                        <span className="block font-mono text-sm">{k in s.states ? (s.states[k] ?? "-") : formatMetric(s.values[k], body?.metrics[k])}</span>
                      </span>
                    ))}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {adding ? (
        <ServiceFormModal
          targetId={targetId}
          onClose={() => setAdding(false)}
          onSaved={(s) => {
            setAdding(false);
            router.push(`/monitoring/infra/${targetId}/services/${s.id}`);
          }}
        />
      ) : null}
    </section>
  );
}
