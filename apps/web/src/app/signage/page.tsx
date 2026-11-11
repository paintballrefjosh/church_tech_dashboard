"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { Plus, Radar, Tv, Users } from "lucide-react";
import type { SignagePlaylist, SignagePreview, SignageScreen, SignageScreenGroup } from "@lampstand/shared";
import { PageTitle } from "@/components/page-title";
import { sendJson } from "@/components/assets-ui";
import { usePoll } from "@/lib/use-poll";
import { Modal } from "../monitoring/network-cisco/cisco-ui";
import { ErrorLine, Forbidden, Label, TvFrame, btnCls, dangerCls, inputCls, primaryCls, useSignageJson, useSignagePerms, when } from "./signage-ui";
import { ScreenFormModal } from "./screen-form";

/** Every screen as a TV on the wall: what it shows now, until when, and whether its Pi answers. */
export default function SignageScreensPage() {
  const perms = useSignagePerms();
  const [screens, setScreens] = useState<SignageScreen[] | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [adding, setAdding] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const groups = useSignageJson<SignageScreenGroup[]>("groups");
  const playlists = useSignageJson<SignagePlaylist[]>("playlists");

  const load = async () => {
    const r = await fetch("/api/signage/screens", { credentials: "same-origin", cache: "no-store" });
    if (r.status === 403) return setForbidden(true);
    if (r.ok) setScreens((await r.json()) as SignageScreen[]);
  };
  usePoll(load, 30_000);

  if (forbidden) return <Forbidden />;
  const offline = screens?.filter((s) => s.device && !s.device.online).length ?? 0;
  const noPi = screens?.filter((s) => !s.device).length ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <PageTitle icon={Tv}>Signage</PageTitle>
          {screens && screens.length ? (
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
              {screens.length} screen{screens.length === 1 ? "" : "s"}
              {offline ? `, ${offline} with its Pi not answering` : ""}
              {noPi ? `, ${noPi} with no Pi yet` : ""}.
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {perms.write ? (
            <button type="button" className={btnCls} onClick={() => setGroupsOpen(true)}>
              <Users className="h-4 w-4" aria-hidden /> Screen groups
            </button>
          ) : null}
          {perms.admin ? (
            <Link href="/signage/devices?tab=found" className={btnCls}>
              <Radar className="h-4 w-4" aria-hidden /> Find Pis
            </Link>
          ) : null}
          {perms.admin ? (
            <button type="button" className={primaryCls} onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" aria-hidden /> Add a screen
            </button>
          ) : null}
        </div>
      </div>

      {screens === null ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>
      ) : screens.length === 0 ? (
        <div className="rounded-md border border-dashed border-slate-300 p-6 text-sm text-slate-600 dark:border-slate-700 dark:text-slate-300">
          <p className="font-medium text-slate-900 dark:text-slate-100">No screens yet.</p>
          <p className="mt-1">
            A screen is one TV. Adopt its Raspberry Pi on the Devices page (that can make the screen for you), or add the screen here
            first and give it a Pi later. Then put pictures and videos in a playlist and schedule it.
          </p>
        </div>
      ) : (
        <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {screens.map((s) => (
            <ScreenTile key={s.id} s={s} />
          ))}
        </ul>
      )}

      {adding ? (
        <ScreenFormModal
          initial={null}
          groups={groups.data ?? []}
          playlists={playlists.data ?? []}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            void load();
          }}
        />
      ) : null}
      {groupsOpen ? <GroupsModal groups={groups.data ?? []} onClose={() => setGroupsOpen(false)} onChanged={() => void groups.reload()} /> : null}
    </div>
  );
}

function ScreenTile({ s }: { s: SignageScreen }) {
  const [preview, setPreview] = useState<SignagePreview | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/signage/screens/${s.id}/preview`, { credentials: "same-origin", cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<SignagePreview>) : null))
      .then((p) => !cancelled && setPreview(p))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [s.id, s.manifestVersion, s.now?.playlistId]);
  const first = preview?.items[0] ?? null;
  const thumb = first ? `/api/signage/media/${first.mediaId}/thumb` : null;
  const device = s.device;
  return (
    <li className="flex flex-col gap-3 rounded-lg border border-slate-300 p-4 dark:border-slate-800">
      <Link href={`/signage/screens/${s.id}`} aria-label={`${s.name}: open`} className="block focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500">
        <TvFrame screen={s} thumb={thumb} label={first ? `Now showing ${first.name}` : "Nothing showing"} />
      </Link>
      <div>
        <Link href={`/signage/screens/${s.id}`} className="font-medium text-slate-900 hover:underline dark:text-slate-100">
          {s.name}
        </Link>
        {s.locationName ? <span className="text-sm text-slate-500 dark:text-slate-400"> · {s.locationName}</span> : null}
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {!s.enabled ? "Switched off in the dashboard" : s.powerNow === "off" ? "TV off by its power schedule" : s.now?.playlistName ? `${s.now.playlistName}` : "Logo slide (nothing scheduled)"}
          {s.enabled && s.powerNow !== "off" && s.now?.until ? <span className="text-slate-500 dark:text-slate-400"> until {when(s.now.until)}</span> : null}
        </p>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {device ? (
            <>
              Pi {device.name}: {device.status !== "active" ? device.status.replace("_", " ") : device.online ? "answering" : <span className="font-medium text-rose-700 dark:text-rose-300">not answering</span>}
            </>
          ) : (
            "No Pi yet"
          )}
          {s.manifestDirty ? " · changes being prepared" : ""}
        </p>
      </div>
    </li>
  );
}

function GroupsModal({ groups, onClose, onChanged }: { groups: SignageScreenGroup[]; onClose: () => void; onChanged: () => void }) {
  const id = useId();
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  async function add(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      await sendJson("/api/signage/groups", "POST", { name: name.trim() });
      setName("");
      onChanged();
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  }
  async function remove(g: SignageScreenGroup) {
    if (!window.confirm(`Delete the group ${g.name}? Schedules for it are deleted too.`)) return;
    try {
      await sendJson(`/api/signage/groups/${g.id}`, "DELETE");
      onChanged();
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  }
  return (
    <Modal title="Screen groups" onClose={onClose}>
      <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">Schedule a playlist on a group to show it on every screen in it. Put screens in groups from each screen&apos;s Edit.</p>
      <ul className="mb-3 divide-y divide-slate-200 dark:divide-slate-800">
        {groups.map((g) => (
          <li key={g.id} className="flex items-center justify-between py-2 text-sm">
            <span>
              {g.name} <span className="text-slate-500 dark:text-slate-400">({g.screenCount} screen{g.screenCount === 1 ? "" : "s"})</span>
            </span>
            <button type="button" className={dangerCls} onClick={() => void remove(g)} aria-label={`Delete group ${g.name}`}>
              Delete
            </button>
          </li>
        ))}
        {groups.length === 0 ? <li className="py-2 text-sm text-slate-500 dark:text-slate-400">No groups yet.</li> : null}
      </ul>
      <form onSubmit={add} className="flex items-end gap-2">
        <div className="flex-1">
          <Label htmlFor={`${id}-g`}>New group</Label>
          <input id={`${id}-g`} className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Foyer screens" maxLength={120} />
        </div>
        <button type="submit" className={primaryCls} disabled={!name.trim()}>
          Add
        </button>
      </form>
      <div className="mt-3">
        <ErrorLine text={err} />
      </div>
      <div className="mt-3 flex justify-end">
        <button type="button" className={btnCls} onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}
