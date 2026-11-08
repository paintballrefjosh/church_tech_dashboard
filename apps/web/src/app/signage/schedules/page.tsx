"use client";

import { useId, useMemo, useState } from "react";
import { CalendarRange, Plus } from "lucide-react";
import type { SignagePlaylist, SignageSchedule, SignageScreen, SignageScreenGroup } from "@lampstand/shared";
import { PageTitle } from "@/components/page-title";
import { sendJson } from "@/components/assets-ui";
import { Modal } from "../../monitoring/network-cisco/cisco-ui";
import { DAY_NAMES, DayPicker, ErrorLine, Forbidden, Label, PlaylistSelect, TargetPicker, btnCls, dangerCls, daysText, inputCls, primaryCls, targetText, useSignageJson, useSignagePerms } from "../signage-ui";

const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** The parts of a weekly rule on each weekday (a window past midnight continues on the next day). */
function blocks(s: SignageSchedule): Array<{ day: number; from: number; to: number }> {
  const a = mins(s.startTime);
  const b = mins(s.endTime);
  const out: Array<{ day: number; from: number; to: number }> = [];
  for (const d of s.daysOfWeek) {
    if (b > a) out.push({ day: d, from: a, to: b });
    else {
      out.push({ day: d, from: a, to: 1440 });
      if (b > 0) out.push({ day: (d % 7) + 1, from: 0, to: b });
    }
  }
  return out;
}

/** Two enabled rules for the same screen or group, at the same priority, that overlap: which wins is arbitrary to a reader. */
function ties(rows: SignageSchedule[]): string[] {
  const out: string[] = [];
  const on = rows.filter((r) => r.enabled);
  for (let i = 0; i < on.length; i++)
    for (let j = i + 1; j < on.length; j++) {
      const a = on[i]!;
      const b = on[j]!;
      if (a.targetType !== b.targetType || a.targetId !== b.targetId || a.priority !== b.priority) continue;
      if (a.endDate && b.startDate && a.endDate < b.startDate) continue;
      if (b.endDate && a.startDate && b.endDate < a.startDate) continue;
      const overlap = blocks(a).some((x) => blocks(b).some((y) => x.day === y.day && x.from < y.to && y.from < x.to));
      if (overlap) out.push(`"${a.name}" and "${b.name}" overlap on ${targetText(a)} at the same priority (${a.priority}): give one a higher priority so it is clear which shows.`);
    }
  return out;
}

export default function SignageSchedulesPage() {
  const perms = useSignagePerms();
  const schedules = useSignageJson<SignageSchedule[]>("schedules");
  const screens = useSignageJson<SignageScreen[]>("screens");
  const groups = useSignageJson<SignageScreenGroup[]>("groups");
  const playlists = useSignageJson<SignagePlaylist[]>("playlists");
  const [editing, setEditing] = useState<SignageSchedule | "new" | null>(null);
  const [focus, setFocus] = useState("");
  const focusId = useId();

  const rows = useMemo(() => {
    const all = schedules.data ?? [];
    if (!focus) return all;
    const [type, id] = focus.split(":");
    if (type === "group") return all.filter((s) => s.targetType === "group" && s.targetId === id);
    // A screen shows its own rules and those of every group it is in.
    const sc = (screens.data ?? []).find((x) => x.id === id);
    return all.filter((s) => (s.targetType === "screen" && s.targetId === id) || (s.targetType === "group" && sc?.groupIds.includes(s.targetId)));
  }, [schedules.data, screens.data, focus]);
  const warnings = useMemo(() => ties(schedules.data ?? []), [schedules.data]);
  const colour = useMemo(() => {
    const palette = ["bg-sky-200 dark:bg-sky-800", "bg-emerald-200 dark:bg-emerald-800", "bg-amber-200 dark:bg-amber-800", "bg-violet-200 dark:bg-violet-800", "bg-rose-200 dark:bg-rose-800", "bg-teal-200 dark:bg-teal-800"];
    const m = new Map<string, string>();
    for (const s of schedules.data ?? []) if (!m.has(s.playlistId)) m.set(s.playlistId, palette[m.size % palette.length]!);
    return m;
  }, [schedules.data]);

  if (schedules.forbidden) return <Forbidden />;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <PageTitle icon={CalendarRange}>Schedule</PageTitle>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            Weekly times a playlist shows on a screen or a screen group. Events (one-off) win over these; a screen&apos;s own rule wins over its group&apos;s; outside every rule it shows its fallback.
          </p>
        </div>
        {perms.write ? (
          <button type="button" className={primaryCls} onClick={() => setEditing("new")}>
            <Plus className="h-4 w-4" aria-hidden /> Add a time
          </button>
        ) : null}
      </div>

      <div className="max-w-sm">
        <Label htmlFor={focusId}>Show</Label>
        <select id={focusId} className={inputCls} value={focus} onChange={(e) => setFocus(e.target.value)}>
          <option value="">Every screen and group</option>
          {(groups.data ?? []).map((g) => (
            <option key={g.id} value={`group:${g.id}`}>
              Group: {g.name}
            </option>
          ))}
          {(screens.data ?? []).map((s) => (
            <option key={s.id} value={`screen:${s.id}`}>
              {s.name} (with its groups)
            </option>
          ))}
        </select>
      </div>

      {warnings.length ? (
        <ul className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          {warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      ) : null}

      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Week of schedules">
        <div className="grid min-w-[640px] grid-cols-[3rem_repeat(7,1fr)] gap-x-1">
          <span />
          {DAY_NAMES.map((d) => (
            <span key={d} className="pb-1 text-center text-xs font-medium text-slate-600 dark:text-slate-300">
              {d}
            </span>
          ))}
          <div className="relative h-[480px] text-[10px] text-slate-500 dark:text-slate-400" aria-hidden>
            {[0, 6, 12, 18].map((h) => (
              <span key={h} className="absolute right-1" style={{ top: `${(h / 24) * 100}%` }}>
                {String(h).padStart(2, "0")}:00
              </span>
            ))}
          </div>
          {DAY_NAMES.map((d, i) => {
            const day = i + 1;
            const parts = rows.flatMap((s) => blocks(s).filter((b) => b.day === day).map((b) => ({ s, b })));
            return (
              <div key={d} className="relative h-[480px] rounded border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/40">
                {[6, 12, 18].map((h) => (
                  <div key={h} className="absolute inset-x-0 border-t border-slate-200 dark:border-slate-800" style={{ top: `${(h / 24) * 100}%` }} aria-hidden />
                ))}
                {parts.map(({ s, b }, k) => (
                  <button
                    type="button"
                    key={`${s.id}-${k}`}
                    onClick={() => perms.write && setEditing(s)}
                    className={`absolute inset-x-0.5 overflow-hidden rounded px-1 text-left text-[10px] leading-tight text-slate-900 dark:text-slate-100 ${colour.get(s.playlistId)} ${s.enabled ? "" : "opacity-60"}`}
                    style={{ top: `${(b.from / 1440) * 100}%`, height: `${Math.max(((b.to - b.from) / 1440) * 100, 2.5)}%` }}
                    aria-label={`${s.name}: ${s.playlistName} on ${targetText(s)}, ${DAY_NAMES[day - 1]} ${s.startTime} to ${s.endTime}${s.enabled ? "" : " (off)"}`}
                  >
                    <span className="block truncate font-medium">{s.playlistName}</span>
                    <span className="block truncate">{targetText(s)}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      </div>

      <table className="w-full text-sm">
        <caption className="sr-only">Every schedule</caption>
        <thead>
          <tr className="border-b border-slate-300 text-left text-xs text-slate-600 dark:border-slate-800 dark:text-slate-300">
            <th className="py-2 pr-2">Name</th>
            <th className="py-2 pr-2">Shows</th>
            <th className="py-2 pr-2">On</th>
            <th className="py-2 pr-2">When</th>
            <th className="py-2 pr-2">Priority</th>
            <th className="py-2">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id} className="border-b border-slate-200 dark:border-slate-800">
              <td className="py-2 pr-2 text-slate-900 dark:text-slate-100">
                {s.name}
                {!s.enabled ? <span className="ml-1 text-xs text-slate-500 dark:text-slate-400">(off)</span> : null}
              </td>
              <td className="py-2 pr-2">{s.playlistName}</td>
              <td className="py-2 pr-2">{targetText(s)}</td>
              <td className="py-2 pr-2">
                {daysText(s.daysOfWeek)} {s.startTime}-{s.endTime}
                {s.startDate || s.endDate ? (
                  <span className="block text-xs text-slate-500 dark:text-slate-400">
                    {s.startDate ? `from ${s.startDate}` : ""} {s.endDate ? `until ${s.endDate}` : ""}
                  </span>
                ) : null}
              </td>
              <td className="py-2 pr-2">{s.priority}</td>
              <td className="py-2 text-right">
                {perms.write ? (
                  <button type="button" className={btnCls} onClick={() => setEditing(s)} aria-label={`Edit ${s.name}`}>
                    Edit
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
          {schedules.data && rows.length === 0 ? (
            <tr>
              <td colSpan={6} className="py-4 text-center text-slate-500 dark:text-slate-400">
                Nothing scheduled{focus ? " here" : ""}.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>

      {editing ? (
        <ScheduleModal
          initial={editing === "new" ? null : editing}
          screens={screens.data ?? []}
          groups={groups.data ?? []}
          playlists={playlists.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void schedules.reload();
          }}
        />
      ) : null}
    </div>
  );
}

function ScheduleModal({
  initial,
  screens,
  groups,
  playlists,
  onClose,
  onSaved,
}: {
  initial: SignageSchedule | null;
  screens: SignageScreen[];
  groups: SignageScreenGroup[];
  playlists: SignagePlaylist[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const id = useId();
  const [name, setName] = useState(initial?.name ?? "");
  const [targetType, setTargetType] = useState<"screen" | "group">(initial?.targetType ?? "screen");
  const [targetId, setTargetId] = useState<string | null>(initial?.targetId ?? null);
  const [playlistId, setPlaylistId] = useState<string | null>(initial?.playlistId ?? null);
  const [days, setDays] = useState<number[]>(initial?.daysOfWeek ?? [7]);
  const [startTime, setStart] = useState(initial?.startTime ?? "08:00");
  const [endTime, setEnd] = useState(initial?.endTime ?? "13:00");
  const [startDate, setStartDate] = useState(initial?.startDate ?? "");
  const [endDate, setEndDate] = useState(initial?.endDate ?? "");
  const [priority, setPriority] = useState(initial?.priority ?? 100);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const body = { name: name.trim(), targetType, targetId, playlistId, daysOfWeek: days, startTime, endTime, startDate: startDate || null, endDate: endDate || null, priority, enabled };
    try {
      if (initial) await sendJson(`/api/signage/schedules/${initial.id}`, "PATCH", body);
      else await sendJson("/api/signage/schedules", "POST", body);
      onSaved();
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  }
  async function remove() {
    if (!initial || !window.confirm(`Delete ${initial.name}?`)) return;
    try {
      await sendJson(`/api/signage/schedules/${initial.id}`, "DELETE");
      onSaved();
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  }
  return (
    <Modal title={initial ? `Edit ${initial.name}` : "Add a time"} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <Label htmlFor={`${id}-n`}>Name</Label>
          <input id={`${id}-n`} className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Sunday morning" maxLength={120} required />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor={`${id}-p`}>Playlist</Label>
            <PlaylistSelect id={`${id}-p`} value={playlistId} onChange={setPlaylistId} playlists={playlists} />
          </div>
          <div>
            <Label htmlFor={`${id}-t`}>On</Label>
            <TargetPicker
              id={`${id}-t`}
              targetType={targetType}
              targetId={targetId}
              onChange={(t, tid) => {
                setTargetType(t === "all" ? "screen" : t);
                setTargetId(tid);
              }}
              screens={screens}
              groups={groups}
              allowAll={false}
            />
          </div>
        </div>
        <DayPicker idPrefix={id} value={days} onChange={setDays} />
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor={`${id}-s`}>From</Label>
            <input id={`${id}-s`} type="time" className={inputCls} value={startTime} onChange={(e) => setStart(e.target.value)} required />
          </div>
          <div>
            <Label htmlFor={`${id}-e`} hint="Earlier than the start = runs past midnight.">
              Until
            </Label>
            <input id={`${id}-e`} type="time" className={inputCls} value={endTime} onChange={(e) => setEnd(e.target.value)} required />
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
        <div className="max-w-[10rem]">
          <Label htmlFor={`${id}-pr`} hint="Higher wins when two overlap.">
            Priority
          </Label>
          <input id={`${id}-pr`} type="number" min={0} max={999} className={inputCls} value={priority} onChange={(e) => setPriority(Number(e.target.value) || 0)} />
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
            <button type="submit" className={primaryCls} disabled={!name.trim() || !playlistId || !targetId || !days.length}>
              Save
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
