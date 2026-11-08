"use client";

import { useId, useState } from "react";
import { CalendarClock, Megaphone, Plus } from "lucide-react";
import type { SignageOverride, SignagePlaylist, SignageScreen, SignageScreenGroup } from "@church/shared";
import { PageTitle } from "@/components/page-title";
import { sendJson } from "@/components/assets-ui";
import { usePoll } from "@/lib/use-poll";
import { Modal } from "../../monitoring/network-cisco/cisco-ui";
import { ErrorLine, Forbidden, Label, PlaylistSelect, TargetPicker, btnCls, dangerCls, inputCls, primaryCls, targetText, toLocalInput, useSignageJson, useSignagePerms, when } from "../signage-ui";

/** The priority an "all screens, right now" notice gets: above anything a person would type for an ordinary event. */
const URGENT_PRIORITY = 100000;

/** One-off events: a playlist on some screens between two moments, over whatever is scheduled. */
export default function SignageEventsPage() {
  const perms = useSignagePerms();
  const [rows, setRows] = useState<SignageOverride[] | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const screens = useSignageJson<SignageScreen[]>("screens");
  const groups = useSignageJson<SignageScreenGroup[]>("groups");
  const playlists = useSignageJson<SignagePlaylist[]>("playlists");
  const [editing, setEditing] = useState<SignageOverride | "new" | "urgent" | null>(null);
  const [showEnded, setShowEnded] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    const r = await fetch("/api/signage/events", { credentials: "same-origin", cache: "no-store" });
    if (r.status === 403) return setForbidden(true);
    if (r.ok) setRows((await r.json()) as SignageOverride[]);
  };
  usePoll(load, 30_000);

  async function endNow(o: SignageOverride) {
    if (!window.confirm(`End ${o.name} now? The screens go back to their schedule.`)) return;
    try {
      await sendJson(`/api/signage/events/${o.id}/end`, "POST");
      void load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  if (forbidden) return <Forbidden />;
  const shown = (rows ?? []).filter((r) => showEnded || r.state !== "ended");
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <PageTitle icon={CalendarClock}>Events</PageTitle>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">A playlist for a while on some screens, over their schedule: a wedding, a conference, a notice. The highest priority wins.</p>
        </div>
        {perms.write ? (
          <div className="flex flex-wrap gap-2">
            <button type="button" className={dangerCls} onClick={() => setEditing("urgent")}>
              <Megaphone className="h-4 w-4" aria-hidden /> Notice on every screen now
            </button>
            <button type="button" className={primaryCls} onClick={() => setEditing("new")}>
              <Plus className="h-4 w-4" aria-hidden /> Add an event
            </button>
          </div>
        ) : null}
      </div>
      <ErrorLine text={err} />
      <label className="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
        <input type="checkbox" checked={showEnded} onChange={(e) => setShowEnded(e.target.checked)} /> Show ended events
      </label>
      {rows === null ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-300 p-6 text-sm text-slate-600 dark:border-slate-700 dark:text-slate-300">No events coming up.</p>
      ) : (
        <ul className="space-y-2">
          {shown.map((o) => (
            <li key={o.id} className={`flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 ${o.state === "active" ? "border-brand-500" : "border-slate-300 dark:border-slate-800"}`}>
              <div>
                <p className="font-medium text-slate-900 dark:text-slate-100">
                  {o.name}{" "}
                  <span className={`ml-1 rounded px-1.5 py-0.5 text-xs ${o.state === "active" ? "bg-brand-100 text-brand-800 dark:bg-brand-900 dark:text-brand-100" : "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200"}`}>
                    {o.state === "active" ? "Showing now" : o.state === "upcoming" ? "Coming up" : "Ended"}
                  </span>
                </p>
                <p className="text-sm text-slate-600 dark:text-slate-300">
                  {o.playlistName} on {targetText(o)} · {when(o.startsAt)} to {when(o.endsAt)} · priority {o.priority}
                  {o.forcePowerOn ? " · switches TVs on" : ""}
                </p>
              </div>
              {perms.write && o.state !== "ended" ? (
                <div className="flex gap-2">
                  {o.state === "active" ? (
                    <button type="button" className={dangerCls} onClick={() => void endNow(o)}>
                      End now
                    </button>
                  ) : null}
                  <button type="button" className={btnCls} onClick={() => setEditing(o)} aria-label={`Edit ${o.name}`}>
                    Edit
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {editing ? (
        <EventModal
          initial={typeof editing === "string" ? null : editing}
          urgent={editing === "urgent"}
          screens={screens.data ?? []}
          groups={groups.data ?? []}
          playlists={playlists.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

function EventModal({
  initial,
  urgent,
  screens,
  groups,
  playlists,
  onClose,
  onSaved,
}: {
  initial: SignageOverride | null;
  urgent: boolean;
  screens: SignageScreen[];
  groups: SignageScreenGroup[];
  playlists: SignagePlaylist[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const id = useId();
  const now = Date.now();
  const [name, setName] = useState(initial?.name ?? (urgent ? "Notice" : ""));
  const [targetType, setTargetType] = useState<"screen" | "group" | "all">(initial?.targetType ?? (urgent ? "all" : "screen"));
  const [targetId, setTargetId] = useState<string | null>(initial?.targetId ?? null);
  const [playlistId, setPlaylistId] = useState<string | null>(initial?.playlistId ?? null);
  const [startsAt, setStartsAt] = useState(toLocalInput(initial?.startsAt ?? new Date(now).toISOString()));
  const [endsAt, setEndsAt] = useState(toLocalInput(initial?.endsAt ?? new Date(now + (urgent ? 2 : 3) * 3600_000).toISOString()));
  const [priority, setPriority] = useState(initial?.priority ?? (urgent ? URGENT_PRIORITY : 1000));
  const [forcePowerOn, setForcePowerOn] = useState(initial?.forcePowerOn ?? urgent);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const body = { name: name.trim(), targetType, targetId: targetType === "all" ? null : targetId, playlistId, startsAt: new Date(startsAt).toISOString(), endsAt: new Date(endsAt).toISOString(), priority, forcePowerOn };
    try {
      if (initial) await sendJson(`/api/signage/events/${initial.id}`, "PATCH", body);
      else await sendJson("/api/signage/events", "POST", body);
      onSaved();
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  }
  async function remove() {
    if (!initial || !window.confirm(`Delete ${initial.name}?`)) return;
    try {
      await sendJson(`/api/signage/events/${initial.id}`, "DELETE");
      onSaved();
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  }
  return (
    <Modal title={initial ? `Edit ${initial.name}` : urgent ? "Notice on every screen" : "Add an event"} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {urgent ? <p className="text-sm text-slate-700 dark:text-slate-200">Every screen shows this playlist from now until the end time, over everything else, and TVs that are off are switched on.</p> : null}
        <div>
          <Label htmlFor={`${id}-n`}>Name</Label>
          <input id={`${id}-n`} className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor={`${id}-p`}>Playlist</Label>
            <PlaylistSelect id={`${id}-p`} value={playlistId} onChange={setPlaylistId} playlists={playlists} />
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
          <div>
            <Label htmlFor={`${id}-s`}>Starts</Label>
            <input id={`${id}-s`} type="datetime-local" className={inputCls} value={startsAt} onChange={(e) => setStartsAt(e.target.value)} required />
          </div>
          <div>
            <Label htmlFor={`${id}-e`}>Ends</Label>
            <input id={`${id}-e`} type="datetime-local" className={inputCls} value={endsAt} onChange={(e) => setEndsAt(e.target.value)} required />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor={`${id}-pr`} hint="Higher wins when two events overlap.">
              Priority
            </Label>
            <input id={`${id}-pr`} type="number" min={0} max={URGENT_PRIORITY} className={inputCls} value={priority} onChange={(e) => setPriority(Number(e.target.value) || 0)} />
          </div>
          <label className="mt-6 inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
            <input type="checkbox" checked={forcePowerOn} onChange={(e) => setForcePowerOn(e.target.checked)} /> Switch TVs on for it
          </label>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">Times are in this computer&apos;s time zone.</p>
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
            <button type="submit" className={primaryCls} disabled={!name.trim() || !playlistId || (targetType !== "all" && !targetId)}>
              Save
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
