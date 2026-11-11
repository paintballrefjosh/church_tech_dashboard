"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { Pencil, Plus, Users, X } from "lucide-react";
import type { SignageScreen, SignageScreenGroup } from "@lampstand/shared";
import { sendJson } from "@/components/assets-ui";
import { ErrorLine, Label, btnCls, dangerCls, inputCls, primaryCls } from "../signage-ui";

/**
 * The Groups tab of the Devices page. A group gathers SCREENS (a schedule can target one to reach every screen in it); a Pi belongs
 * to a group through the screen it drives, so each member is listed with its Pi. Creating, renaming and deleting groups needs Signage
 * write; putting screens in and out of a group is a screen edit, which needs Signage admin (the same rule as a screen's Edit form).
 */
export function GroupsPanel({
  groups,
  screens,
  canWrite,
  canAssign,
  onChanged,
}: {
  groups: SignageScreenGroup[] | null;
  screens: SignageScreen[];
  canWrite: boolean;
  canAssign: boolean;
  onChanged: () => void;
}) {
  const id = useId();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [err, setErr] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      await sendJson("/api/signage/groups", "POST", { name: name.trim(), description: description.trim() });
      setName("");
      setDescription("");
      onChanged();
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  }

  return (
    <section aria-labelledby={`${id}-h`} className="space-y-4">
      <div>
        <h2 id={`${id}-h`} className="text-base font-semibold text-slate-900 dark:text-slate-100">
          Groups
        </h2>
        <p className="mt-1 max-w-3xl text-sm text-slate-600 dark:text-slate-300">
          A group gathers screens so one schedule entry can show a playlist on every screen in it. A Pi is in a group through the screen it drives.
        </p>
      </div>
      <ErrorLine text={err} />
      {canWrite ? (
        <form onSubmit={add} className="flex flex-wrap items-end gap-2">
          <div className="min-w-[14rem] flex-1">
            <Label htmlFor={`${id}-n`}>New group</Label>
            <input id={`${id}-n`} className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Foyer screens" maxLength={120} />
          </div>
          <div className="min-w-[14rem] flex-1">
            <Label htmlFor={`${id}-d`}>Description (optional)</Label>
            <input id={`${id}-d`} className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
          </div>
          <button type="submit" className={primaryCls} disabled={!name.trim()}>
            <Plus className="h-4 w-4" aria-hidden /> Add group
          </button>
        </form>
      ) : null}
      {groups === null ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>
      ) : groups.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-300 p-6 text-sm text-slate-600 dark:border-slate-700 dark:text-slate-300">No groups yet.{canWrite ? " Add one above, then put screens in it." : ""}</p>
      ) : (
        <ul className="grid gap-4 lg:grid-cols-2">
          {groups.map((g) => (
            <GroupCard key={g.id} group={g} screens={screens} canWrite={canWrite} canAssign={canAssign} onChanged={onChanged} onError={setErr} />
          ))}
        </ul>
      )}
    </section>
  );
}

function GroupCard({
  group,
  screens,
  canWrite,
  canAssign,
  onChanged,
  onError,
}: {
  group: SignageScreenGroup;
  screens: SignageScreen[];
  canWrite: boolean;
  canAssign: boolean;
  onChanged: () => void;
  onError: (m: string | null) => void;
}) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(group.name);
  const [description, setDescription] = useState(group.description);
  const [pick, setPick] = useState("");
  const members = screens.filter((s) => s.groupIds.includes(group.id));
  const others = screens.filter((s) => !s.groupIds.includes(group.id));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    onError(null);
    try {
      await sendJson(`/api/signage/groups/${group.id}`, "PATCH", { name: name.trim(), description: description.trim() });
      setEditing(false);
      onChanged();
    } catch (e2) {
      onError((e2 as Error).message);
    }
  }
  async function remove() {
    if (!window.confirm(`Delete the group ${group.name}? Schedule entries for it are deleted too. The screens and their Pis are kept.`)) return;
    onError(null);
    try {
      await sendJson(`/api/signage/groups/${group.id}`, "DELETE");
      onChanged();
    } catch (e2) {
      onError((e2 as Error).message);
    }
  }
  async function setMembership(s: SignageScreen, inGroup: boolean) {
    onError(null);
    try {
      await sendJson(`/api/signage/screens/${s.id}`, "PATCH", { groupIds: inGroup ? [...s.groupIds, group.id] : s.groupIds.filter((x) => x !== group.id) });
      setPick("");
      onChanged();
    } catch (e2) {
      onError((e2 as Error).message);
    }
  }

  return (
    <li className="space-y-3 rounded-lg border border-slate-300 p-4 dark:border-slate-800">
      {editing ? (
        <form onSubmit={save} className="space-y-2">
          <div>
            <Label htmlFor={`${id}-n`}>Name</Label>
            <input id={`${id}-n`} className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required />
          </div>
          <div>
            <Label htmlFor={`${id}-d`}>Description</Label>
            <input id={`${id}-d`} className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className={btnCls}
              onClick={() => {
                setEditing(false);
                setName(group.name);
                setDescription(group.description);
              }}
            >
              Cancel
            </button>
            <button type="submit" className={primaryCls} disabled={!name.trim()}>
              Save
            </button>
          </div>
        </form>
      ) : (
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="flex items-center gap-1.5 font-semibold text-slate-900 dark:text-slate-100">
              <Users className="h-4 w-4 shrink-0 text-slate-500 dark:text-slate-400" aria-hidden /> <span className="truncate">{group.name}</span>
            </h3>
            {group.description ? <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-300">{group.description}</p> : null}
          </div>
          {canWrite ? (
            <div className="flex shrink-0 gap-2">
              <button type="button" className={btnCls} onClick={() => setEditing(true)} aria-label={`Rename ${group.name}`}>
                <Pencil className="h-4 w-4" aria-hidden /> Edit
              </button>
              <button type="button" className={dangerCls} onClick={() => void remove()} aria-label={`Delete group ${group.name}`}>
                Delete
              </button>
            </div>
          ) : null}
        </div>
      )}

      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">
          Screens in this group ({members.length})
        </h4>
        {members.length === 0 ? (
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">No screens yet.</p>
        ) : (
          <ul className="mt-1 divide-y divide-slate-200 dark:divide-slate-800">
            {members.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-2 py-1.5 text-sm">
                <span className="min-w-0">
                  <Link href={`/signage/screens/${s.id}`} className="font-medium text-brand-600 hover:underline dark:text-brand-400">
                    {s.name}
                  </Link>
                  <span className="text-slate-600 dark:text-slate-300">
                    {" "}
                    {s.device ? (
                      <>
                        on{" "}
                        <Link href={`/signage/devices/${s.device.id}`} className="text-brand-600 hover:underline dark:text-brand-400">
                          {s.device.name}
                        </Link>
                      </>
                    ) : (
                      "(no Pi yet)"
                    )}
                  </span>
                </span>
                {canAssign ? (
                  <button type="button" className={btnCls} onClick={() => void setMembership(s, false)} aria-label={`Take ${s.name} out of ${group.name}`}>
                    <X className="h-4 w-4" aria-hidden /> Remove
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {canAssign ? (
        others.length ? (
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Label htmlFor={`${id}-add`}>Add a screen</Label>
              <select id={`${id}-add`} className={inputCls} value={pick} onChange={(e) => setPick(e.target.value)}>
                <option value="">Choose a screen</option>
                {others.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.device ? ` (${s.device.name})` : ""}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className={btnCls}
              disabled={!pick}
              onClick={() => {
                const s = screens.find((x) => x.id === pick);
                if (s) void setMembership(s, true);
              }}
            >
              Add
            </button>
          </div>
        ) : (
          <p className="text-xs text-slate-500 dark:text-slate-400">Every screen is already in this group.</p>
        )
      ) : null}
    </li>
  );
}
