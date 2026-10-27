"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import type { ServiceGroup, ServiceGroupSave, ServiceInstance } from "@church/shared";
import { DialogFrame } from "@/components/modal";
import { usePoll } from "@/lib/use-poll";
import { ToastStack, inputCls, useCanWrite, useToasts } from "../../network-cisco/cisco-ui";
import { ServiceStatusPill, ago, btnCls, helpCls, labelCls, primaryBtnCls, svcGet, svcSend } from "../services/services-ui";

/** The list of service groups, and (for those who may change monitoring) the button that makes one. */
export function ServiceGroupsClient() {
  const canWrite = useCanWrite();
  const [list, setList] = useState<ServiceGroup[] | null>(null);
  const [creating, setCreating] = useState(false);
  const { toasts, show, dismiss } = useToasts();
  const load = useCallback(async () => {
    const g = await svcGet<ServiceGroup[]>("/groups");
    if (g) setList(g);
  }, []);
  usePoll(load, 20_000);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center gap-3">
        <div>
          <h2 className="text-lg font-semibold">Service groups</h2>
          <p className="max-w-2xl text-sm text-slate-500 dark:text-slate-400">
            Services on different hosts that make one thing: a database cluster, a pair of load balancers. Each service is still checked on its own host;
            a group also alerts when too few of them are working, or when the number holding a role (such as MASTER) is wrong.
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          <Link href="/monitoring/infra/service-templates" className={btnCls}>
            Service templates
          </Link>
          {canWrite ? (
            <button className={primaryBtnCls} onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" aria-hidden /> New group
            </button>
          ) : null}
        </div>
      </header>
      {list === null ? (
        <p className={helpCls}>Loading…</p>
      ) : list.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
          No groups yet. Add the services to their hosts first, then group them here.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-slate-300 dark:border-slate-800" tabIndex={0} role="region" aria-label="Service groups">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs text-slate-600 dark:bg-slate-900 dark:text-slate-300">
              <tr>
                <th className="px-3 py-2 font-medium">Group</th>
                <th className="px-3 py-2 font-medium">State</th>
                <th className="px-3 py-2 font-medium">Working</th>
                <th className="px-3 py-2 font-medium">Rules</th>
                <th className="px-3 py-2 font-medium">Judged</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {list.map((g) => (
                <tr key={g.id}>
                  <td className="px-3 py-2">
                    <Link href={`/monitoring/infra/service-groups/${g.id}`} className="font-medium text-brand-600 hover:underline dark:text-brand-400">
                      {g.name}
                    </Link>
                    {g.description ? <span className="block text-xs text-slate-500 dark:text-slate-400">{g.description}</span> : null}
                  </td>
                  <td className="px-3 py-2">
                    <ServiceStatusPill status={g.status} />
                    {!g.alerts ? <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">Alerts off</span> : null}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {g.working} of {g.counted}
                  </td>
                  <td className="px-3 py-2 text-xs">{rulesText(g)}</td>
                  <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">{ago(g.lastEvaluatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating ? (
        <GroupFormModal
          group={null}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            show(true, "Group saved.");
            void load();
          }}
        />
      ) : null}
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

/** "2 of 3 needed; exactly 1 MASTER", in words. */
export function rulesText(g: Pick<ServiceGroup, "minHealthy" | "role" | "counted">): string {
  const parts = [g.minHealthy === null ? "all working" : `${g.minHealthy} working needed`];
  if (g.role) {
    const r = g.role;
    const want = r.max === null ? `at least ${r.min}` : r.min === r.max ? `exactly ${r.min}` : `${r.min} to ${r.max}`;
    parts.push(`${want} ${r.value}`);
  }
  return parts.join("; ");
}

/** Add or change a group: name, members (services from any host), quorum, an optional role rule, alerts. */
export function GroupFormModal({ group, onClose, onSaved }: { group: ServiceGroup | null; onClose: () => void; onSaved: (g: ServiceGroup) => void }) {
  const router = useRouter();
  const titleId = useId();
  const nameId = useId();
  const descId = useId();
  const quorumId = useId();
  const forId = useId();
  const metricId = useId();
  const valueId = useId();
  const minId = useId();
  const maxId = useId();
  const filterId = useId();
  const [services, setServices] = useState<ServiceInstance[] | null>(null);
  const [name, setName] = useState(group?.name ?? "");
  const [description, setDescription] = useState(group?.description ?? "");
  const [members, setMembers] = useState<Set<string>>(new Set(group?.members.map((m) => m.id) ?? []));
  const [quorum, setQuorum] = useState(group?.minHealthy === null || group?.minHealthy === undefined ? "" : String(group.minHealthy));
  const [useRole, setUseRole] = useState(!!group?.role);
  const [metric, setMetric] = useState(group?.role?.metric ?? "");
  const [value, setValue] = useState(group?.role?.value ?? "");
  const [min, setMin] = useState(String(group?.role?.min ?? 1));
  const [max, setMax] = useState(group?.role ? (group.role.max === null ? "" : String(group.role.max)) : "1");
  const [forSec, setForSec] = useState(String(group?.forSec ?? 60));
  const [alerts, setAlerts] = useState(group?.alerts ?? true);
  const [filter, setFilter] = useState("");
  const [choices, setChoices] = useState<Array<{ metric: string; label: string }>>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void svcGet<ServiceInstance[]>("/instances").then((l) => setServices(l ?? []));
  }, []);
  const memberKey = [...members].sort().join(",");
  useEffect(() => {
    if (!memberKey) return setChoices([]);
    void svcGet<Array<{ metric: string; label: string }>>(`/groups/role-choices?ids=${memberKey}`).then((c) => setChoices(c ?? []));
  }, [memberKey]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (services ?? []).filter((s) => !q || `${s.name} ${s.targetName} ${s.templateName}`.toLowerCase().includes(q));
  }, [services, filter]);

  function toggle(id: string) {
    setMembers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setErr(null);
    const input: ServiceGroupSave = {
      name: name.trim(),
      description: description.trim(),
      minHealthy: quorum.trim() ? Number(quorum) : null,
      role: useRole ? { metric, value: value.trim(), min: Number(min), max: max.trim() ? Number(max) : null } : null,
      forSec: Number(forSec) || 0,
      alerts,
      instanceIds: [...members],
    };
    try {
      const saved = group ? await svcSend<ServiceGroup>(`/groups/${group.id}`, "PUT", input) : await svcSend<ServiceGroup>("/groups", "POST", input);
      onSaved(saved);
      if (!group) router.push(`/monitoring/infra/service-groups/${saved.id}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const roleOk = !useRole || (metric && value.trim());
  return (
    <DialogFrame
      onClose={onClose}
      labelledBy={titleId}
      closeOnBackdrop={false}
      className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-slate-300 bg-white p-5 shadow-xl dark:border-slate-700 dark:bg-slate-900"
    >
      <h2 id={titleId} className="mb-3 text-base font-semibold">
        {group ? `Edit ${group.name}` : "New service group"}
      </h2>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <label htmlFor={nameId} className={labelCls}>
              Name
            </label>
            <input id={nameId} className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required />
          </div>
          <div className="space-y-1">
            <label htmlFor={descId} className={labelCls}>
              Description
            </label>
            <input id={descId} className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
          </div>
        </div>

        <fieldset className="space-y-2">
          <legend className={labelCls}>Services in the group ({members.size})</legend>
          <label htmlFor={filterId} className="sr-only">
            Filter services
          </label>
          <input id={filterId} className={inputCls} placeholder="Filter by name, host or template" value={filter} onChange={(e) => setFilter(e.target.value)} />
          {services === null ? (
            <p className={helpCls}>Loading…</p>
          ) : services.length === 0 ? (
            <p className={helpCls}>No services yet: add them from a host&apos;s page first.</p>
          ) : (
            <ul className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-slate-200 p-2 dark:border-slate-800" aria-label="Services">
              {shown.map((s) => (
                <li key={s.id}>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={members.has(s.id)} onChange={() => toggle(s.id)} className="h-4 w-4" />
                    <span>
                      <span className="font-medium">{s.name}</span> on {s.targetName}{" "}
                      <span className="text-xs text-slate-500 dark:text-slate-400">
                        ({s.templateName}
                        {s.groupId && s.groupId !== group?.id ? `, now in ${s.groupName}` : ""})
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <p className={helpCls}>A service belongs to one group at most: ticking one that is in another group moves it here.</p>
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <label htmlFor={quorumId} className={labelCls}>
              Working services needed
            </label>
            <input
              id={quorumId}
              className={inputCls}
              type="number"
              min={1}
              max={Math.max(1, members.size)}
              placeholder={`all (${members.size})`}
              value={quorum}
              onChange={(e) => setQuorum(e.target.value)}
              aria-describedby={`${quorumId}-help`}
            />
            <p id={`${quorumId}-help`} className={helpCls}>
              Blank = every one. A three-node cluster that survives one loss needs 2.
            </p>
          </div>
          <div className="space-y-1">
            <label htmlFor={forId} className={labelCls}>
              Alert after (seconds)
            </label>
            <input id={forId} className={inputCls} type="number" min={0} max={3600} value={forSec} onChange={(e) => setForSec(e.target.value)} />
          </div>
        </div>

        <fieldset className="space-y-2 rounded-md border border-slate-200 p-3 dark:border-slate-800">
          <legend className="px-1">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" checked={useRole} onChange={(e) => setUseRole(e.target.checked)} className="h-4 w-4" disabled={!useRole && choices.length === 0} />
              Count a role
            </label>
          </legend>
          {!useRole && choices.length === 0 ? (
            <p className={helpCls}>Only offered when every service in the group reports the same state (keepalived&apos;s role, a database&apos;s primary or standby).</p>
          ) : null}
          {useRole ? (
            <div className="grid gap-3 sm:grid-cols-4">
              <div className="space-y-1">
                <label htmlFor={metricId} className={labelCls}>
                  State
                </label>
                <select id={metricId} className={inputCls} value={metric} onChange={(e) => setMetric(e.target.value)}>
                  <option value="">Choose…</option>
                  {choices.map((c) => (
                    <option key={c.metric} value={c.metric}>
                      {c.label}
                    </option>
                  ))}
                  {metric && !choices.some((c) => c.metric === metric) ? <option value={metric}>{metric} (not shared by every member)</option> : null}
                </select>
              </div>
              <div className="space-y-1">
                <label htmlFor={valueId} className={labelCls}>
                  Value
                </label>
                <input id={valueId} className={inputCls} placeholder="MASTER" value={value} onChange={(e) => setValue(e.target.value)} maxLength={100} />
              </div>
              <div className="space-y-1">
                <label htmlFor={minId} className={labelCls}>
                  Fewest
                </label>
                <input id={minId} className={inputCls} type="number" min={0} max={100} value={min} onChange={(e) => setMin(e.target.value)} />
              </div>
              <div className="space-y-1">
                <label htmlFor={maxId} className={labelCls}>
                  Most
                </label>
                <input id={maxId} className={inputCls} type="number" min={0} max={100} placeholder="no limit" value={max} onChange={(e) => setMax(e.target.value)} />
              </div>
            </div>
          ) : null}
        </fieldset>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={alerts} onChange={(e) => setAlerts(e.target.checked)} className="h-4 w-4" />
          Send alerts (off: problems are still recorded, nobody is told)
        </label>

        {err ? (
          <p role="alert" className="text-sm text-rose-700 dark:text-rose-300">
            {err}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button type="button" className={btnCls} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={primaryBtnCls} disabled={saving || !name.trim() || !roleOk}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </DialogFrame>
  );
}
