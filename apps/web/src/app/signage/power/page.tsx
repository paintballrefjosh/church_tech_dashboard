"use client";

import { useId, useState } from "react";
import { Plus, Power } from "lucide-react";
import type { SignagePowerSchedule, SignageScreen, SignageScreenGroup } from "@lampstand/shared";
import { PageTitle } from "@/components/page-title";
import { sendJson } from "@/components/assets-ui";
import { Modal } from "../../monitoring/network-cisco/cisco-ui";
import { DayPicker, ErrorLine, Forbidden, Label, TargetPicker, btnCls, dangerCls, daysText, inputCls, primaryCls, targetText, useSignageJson, useSignagePerms } from "../signage-ui";

/** When TVs are on. A screen with no power rule is left as it is; outside its "on" times a managed screen is off. */
export default function SignagePowerPage() {
  const perms = useSignagePerms();
  const rules = useSignageJson<SignagePowerSchedule[]>("power");
  const screens = useSignageJson<SignageScreen[]>("screens");
  const groups = useSignageJson<SignageScreenGroup[]>("groups");
  const [editing, setEditing] = useState<SignagePowerSchedule | "new" | null>(null);
  const [allMsg, setAllMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function all(state: "on" | "off") {
    if (!window.confirm(`Switch every TV ${state} now? Their power schedules put them back at the next change.`)) return;
    setBusy(true);
    setAllMsg(null);
    try {
      const r = await sendJson<{ results: Array<{ screenId: string; name: string; ok: boolean; message: string }> }>("/api/signage/power-all", "POST", { state });
      const failed = r.results.filter((x) => !x.ok);
      const done = r.results.length - failed.length;
      setAllMsg({
        ok: failed.length === 0,
        text: r.results.length === 0 ? "No screen has TV control set up." : `${done} switched ${state}${failed.length ? `; not reached: ${failed.map((f) => `${f.name} (${f.message})`).join(", ")}` : "."}`,
      });
    } catch (e) {
      setAllMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (rules.forbidden) return <Forbidden />;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <PageTitle icon={Power}>Power</PageTitle>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            When TVs switch on and off. A screen with no rule here is never switched. The Pi keeps to these times even when the dashboard cannot reach it.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {perms.admin ? (
            <>
              <button type="button" className={btnCls} disabled={busy} onClick={() => void all("on")}>
                All TVs on
              </button>
              <button type="button" className={dangerCls} disabled={busy} onClick={() => void all("off")}>
                All TVs off
              </button>
            </>
          ) : null}
          {perms.write ? (
            <button type="button" className={primaryCls} onClick={() => setEditing("new")}>
              <Plus className="h-4 w-4" aria-hidden /> Add on times
            </button>
          ) : null}
        </div>
      </div>
      {allMsg ? <p className={`text-sm ${allMsg.ok ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300"}`}>{allMsg.text}</p> : null}
      {rules.data === null ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>
      ) : rules.data.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-300 p-6 text-sm text-slate-600 dark:border-slate-700 dark:text-slate-300">No power times yet: every TV stays as it is.</p>
      ) : (
        <ul className="space-y-2">
          {rules.data.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-slate-300 p-3 dark:border-slate-800">
              <div>
                <p className="font-medium text-slate-900 dark:text-slate-100">
                  {p.name}
                  {!p.enabled ? <span className="ml-1 text-xs text-slate-500 dark:text-slate-400">(off)</span> : null}
                </p>
                <p className="text-sm text-slate-600 dark:text-slate-300">
                  {targetText(p)} · {daysText(p.daysOfWeek)} on {p.onTime}, off {p.offTime}
                  {p.startDate || p.endDate ? ` · ${p.startDate ? `from ${p.startDate}` : ""} ${p.endDate ? `until ${p.endDate}` : ""}` : ""}
                </p>
              </div>
              {perms.write ? (
                <button type="button" className={btnCls} onClick={() => setEditing(p)} aria-label={`Edit ${p.name}`}>
                  Edit
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {editing ? (
        <PowerModal
          initial={editing === "new" ? null : editing}
          screens={screens.data ?? []}
          groups={groups.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void rules.reload();
          }}
        />
      ) : null}
    </div>
  );
}

function PowerModal({ initial, screens, groups, onClose, onSaved }: { initial: SignagePowerSchedule | null; screens: SignageScreen[]; groups: SignageScreenGroup[]; onClose: () => void; onSaved: () => void }) {
  const id = useId();
  const [name, setName] = useState(initial?.name ?? "");
  const [targetType, setTargetType] = useState<"screen" | "group" | "all">(initial?.targetType ?? "all");
  const [targetId, setTargetId] = useState<string | null>(initial?.targetId ?? null);
  const [days, setDays] = useState<number[]>(initial?.daysOfWeek ?? [1, 2, 3, 4, 5, 6, 7]);
  const [onTime, setOn] = useState(initial?.onTime ?? "07:30");
  const [offTime, setOff] = useState(initial?.offTime ?? "21:00");
  const [startDate, setStartDate] = useState(initial?.startDate ?? "");
  const [endDate, setEndDate] = useState(initial?.endDate ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const body = { name: name.trim(), targetType, targetId: targetType === "all" ? null : targetId, daysOfWeek: days, onTime, offTime, startDate: startDate || null, endDate: endDate || null, enabled };
    try {
      if (initial) await sendJson(`/api/signage/power/${initial.id}`, "PATCH", body);
      else await sendJson("/api/signage/power", "POST", body);
      onSaved();
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  }
  async function remove() {
    if (!initial || !window.confirm(`Delete ${initial.name}?`)) return;
    try {
      await sendJson(`/api/signage/power/${initial.id}`, "DELETE");
      onSaved();
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  }
  return (
    <Modal title={initial ? `Edit ${initial.name}` : "Add on times"} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <Label htmlFor={`${id}-n`}>Name</Label>
          <input id={`${id}-n`} className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Open hours" maxLength={120} required />
        </div>
        <div>
          <Label htmlFor={`${id}-t`}>Screens</Label>
          <TargetPicker
            id={`${id}-t`}
            targetType={targetType}
            targetId={targetId}
            onChange={(t, tid) => {
              setTargetType(t);
              setTargetId(tid);
            }}
            screens={screens}
            groups={groups}
            allowAll
          />
        </div>
        <DayPicker idPrefix={id} value={days} onChange={setDays} />
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor={`${id}-on`}>On at</Label>
            <input id={`${id}-on`} type="time" className={inputCls} value={onTime} onChange={(e) => setOn(e.target.value)} required />
          </div>
          <div>
            <Label htmlFor={`${id}-off`} hint="Earlier than on = stays on past midnight.">
              Off at
            </Label>
            <input id={`${id}-off`} type="time" className={inputCls} value={offTime} onChange={(e) => setOff(e.target.value)} required />
          </div>
          <div>
            <Label htmlFor={`${id}-sd`}>First day (optional)</Label>
            <input id={`${id}-sd`} type="date" className={inputCls} value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>
          <div>
            <Label htmlFor={`${id}-ed`}>Last day (optional)</Label>
            <input id={`${id}-ed`} type="date" className={inputCls} value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </div>
        </div>
        <label className="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> On
        </label>
        <ErrorLine text={err} />
        <div className="flex justify-between gap-2">
          {initial ? (
            <button type="button" className={dangerCls} onClick={() => void remove()}>
              Delete
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button type="button" className={btnCls} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className={primaryCls} disabled={!name.trim() || !days.length || (targetType !== "all" && !targetId)}>
              Save
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
