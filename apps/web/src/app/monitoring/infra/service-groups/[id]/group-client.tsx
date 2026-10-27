"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowLeft, CircleCheck, Pencil, Trash2 } from "lucide-react";
import type { ServiceGroup } from "@church/shared";
import { GoneNotice } from "@/components/gone-notice";
import { usePoll } from "@/lib/use-poll";
import { ToastStack, cardCls, useCanWrite, useToasts } from "../../../network-cisco/cisco-ui";
import { AcknowledgeButton } from "../../../acknowledge-button";
import { ServiceStatusPill, ago, btnCls, svcGet, svcSend } from "../../services/services-ui";
import { GroupFormModal, rulesText } from "../groups-client";

interface Incident {
  id: string;
  ruleId: string | null;
  reason: string | null;
  startedAt: string;
  resolvedAt: string | null;
  acknowledgedAt: string | null;
}

export function ServiceGroupClient({ id }: { id: string }) {
  const router = useRouter();
  const canWrite = useCanWrite();
  const [g, setG] = useState<ServiceGroup | null>(null);
  const [gone, setGone] = useState(false);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [editing, setEditing] = useState(false);
  const { toasts, show, dismiss } = useToasts();

  const load = useCallback(async () => {
    const r = await fetch(`/api/service-monitoring/groups/${id}`, { credentials: "same-origin", cache: "no-store" }).catch(() => null);
    if (r && (r.status === 404 || r.status === 400)) return setGone(true);
    if (!r?.ok) return;
    setG((await r.json()) as ServiceGroup);
    const inc = await svcGet<Incident[]>(`/groups/${id}/incidents`);
    if (inc) setIncidents(inc);
  }, [id]);
  usePoll(load, 20_000);

  async function remove() {
    if (!g || !window.confirm(`Delete the group ${g.name}? Its services stay; only the group and its alert history go.`)) return;
    try {
      await svcSend(`/groups/${id}`, "DELETE");
      router.push("/monitoring/infra/service-groups");
    } catch (e) {
      show(false, (e as Error).message);
    }
  }

  if (gone) return <GoneNotice what="service group" backHref="/monitoring/infra/service-groups" backLabel="Back to the groups" />;
  if (!g) return <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>;

  return (
    <div className="space-y-6">
      <Link href="/monitoring/infra/service-groups" className="inline-flex items-center gap-1 text-sm text-brand-600 hover:underline dark:text-brand-400">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Service groups
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold">
            {g.name} <ServiceStatusPill status={g.status} />
            {!g.alerts ? <span className="text-sm font-normal text-slate-500 dark:text-slate-400">Alerts off</span> : null}
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            {g.working} of {g.counted} working · {rulesText(g)} · alerts after {g.forSec} s · judged {ago(g.lastEvaluatedAt)}
          </p>
          {g.description ? <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{g.description}</p> : null}
        </div>
        {canWrite ? (
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setEditing(true)} className={btnCls}>
              <Pencil className="h-4 w-4" aria-hidden /> Edit
            </button>
            <button
              onClick={() => void remove()}
              className="inline-flex items-center gap-1.5 rounded-md border border-rose-300 px-3 py-1.5 text-sm text-rose-700 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-300 dark:hover:bg-rose-950"
            >
              <Trash2 className="h-4 w-4" aria-hidden /> Delete
            </button>
          </div>
        ) : null}
      </div>

      <section className={cardCls} aria-labelledby="grp-checks">
        <h2 id="grp-checks" className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Checks
        </h2>
        {g.checks.length === 0 ? (
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">Nothing to judge: the group has no services that are switched on.</p>
        ) : (
          <ul className="mt-2 space-y-1 text-sm">
            {g.checks.map((c) => (
              <li key={c.id} className="flex items-start gap-2">
                {c.breaching ? (
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" aria-hidden />
                ) : (
                  <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700 dark:text-emerald-400" aria-hidden />
                )}
                <span>
                  <span className="font-medium">{c.id === "quorum" ? "Enough working" : "Role"}</span>: {c.text}
                  {c.breaching && !c.open ? <span className="text-slate-500 dark:text-slate-400"> (waiting for it to last)</span> : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={cardCls} aria-labelledby="grp-members">
        <h2 id="grp-members" className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Services
        </h2>
        {g.members.length === 0 ? (
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">No services in this group yet.</p>
        ) : (
          <div className="mt-2 overflow-x-auto" tabIndex={0} role="region" aria-label="Services in the group">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-slate-500 dark:text-slate-400">
                <tr>
                  <th className="py-1 pr-3 font-medium">Service</th>
                  <th className="py-1 pr-3 font-medium">Host</th>
                  <th className="py-1 pr-3 font-medium">State</th>
                  <th className="py-1 pr-3 font-medium">Counts as working</th>
                  {g.role ? <th className="py-1 pr-3 font-medium">{g.role.metric.replace(/_/g, " ")}</th> : null}
                  <th className="py-1 pr-3 font-medium">Checked</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {g.members.map((m) => (
                  <tr key={m.id}>
                    <td className="py-1.5 pr-3">
                      <Link href={`/monitoring/infra/${m.targetId}/services/${m.id}`} className="font-medium text-brand-600 hover:underline dark:text-brand-400">
                        {m.name}
                      </Link>
                      <span className="block text-xs text-slate-500 dark:text-slate-400">{m.templateName}</span>
                    </td>
                    <td className="py-1.5 pr-3">
                      <Link href={`/monitoring/infra/${m.targetId}`} className="text-brand-600 hover:underline dark:text-brand-400">
                        {m.targetName}
                      </Link>
                    </td>
                    <td className="py-1.5 pr-3">
                      <ServiceStatusPill status={m.status} />
                    </td>
                    <td className="py-1.5 pr-3 text-xs">
                      {m.status === "disabled" ? (
                        "not counted"
                      ) : m.working ? (
                        <span className="text-emerald-700 dark:text-emerald-400">yes</span>
                      ) : (
                        <span className="font-medium text-rose-700 dark:text-rose-300">{m.stale ? "no (no recent reading)" : "no"}</span>
                      )}
                    </td>
                    {g.role ? <td className="py-1.5 pr-3 font-mono text-xs">{m.role ?? "-"}</td> : null}
                    <td className="py-1.5 pr-3 text-xs text-slate-500 dark:text-slate-400">{ago(m.lastPolledAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={cardCls} aria-labelledby="grp-incidents">
        <h2 id="grp-incidents" className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Alert history
        </h2>
        {incidents.length === 0 ? (
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">No alerts recorded.</p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-200 text-xs dark:divide-slate-800">
            {incidents.map((i) => (
              <li key={i.id} className="flex items-center gap-3 py-2">
                {i.resolvedAt ? (
                  <CircleCheck className="h-4 w-4 shrink-0 text-emerald-700 dark:text-emerald-400" aria-hidden />
                ) : (
                  <AlertTriangle className="h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" aria-hidden />
                )}
                <div className="min-w-0 flex-1">
                  <div className="font-medium">
                    {i.resolvedAt ? "Resolved" : "Open"}
                    {i.reason ? ` - ${i.reason}` : ""}
                  </div>
                  <div className="text-slate-500 dark:text-slate-400">
                    started {new Date(i.startedAt).toLocaleString()}
                    {i.resolvedAt ? `, resolved ${new Date(i.resolvedAt).toLocaleString()}` : ""}
                    {i.acknowledgedAt ? `, acknowledged ${new Date(i.acknowledgedAt).toLocaleString()}` : ""}
                  </div>
                </div>
                {canWrite && !i.resolvedAt && !i.acknowledgedAt ? (
                  <AcknowledgeButton incidentId={i.id} onAcknowledged={(at) => setIncidents((list) => list.map((x) => (x.id === i.id ? { ...x, acknowledgedAt: at } : x)))} />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {editing ? (
        <GroupFormModal
          group={g}
          onClose={() => setEditing(false)}
          onSaved={(saved) => {
            setEditing(false);
            setG(saved);
            show(true, "Saved.");
          }}
        />
      ) : null}
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
