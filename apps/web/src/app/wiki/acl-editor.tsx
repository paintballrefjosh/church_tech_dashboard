"use client";

import { useMemo, useState } from "react";

interface GroupBrief {
  id: string;
  name: string;
}

export type AclState = Array<{ groupId: string; canEdit: boolean }>;

export function AclEditor({
  groups,
  value,
  onChange,
}: {
  groups: GroupBrief[];
  value: AclState;
  onChange: (next: AclState) => void;
}) {
  const groupMap = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups]);
  const [picked, setPicked] = useState("");

  const available = groups.filter((g) => !value.some((a) => a.groupId === g.id));

  function add() {
    if (!picked) return;
    onChange([...value, { groupId: picked, canEdit: false }]);
    setPicked("");
  }
  function setCanEdit(groupId: string, canEdit: boolean) {
    onChange(value.map((a) => (a.groupId === groupId ? { ...a, canEdit } : a)));
  }
  function remove(groupId: string) {
    onChange(value.filter((a) => a.groupId !== groupId));
  }

  if (groups.length === 0) {
    return (
      <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300">
        No groups available. Create one in admin first, then restricted visibility becomes usable.
      </p>
    );
  }

  return (
    <div className="space-y-3 text-sm">
      <div className="flex gap-2">
        <select
          value={picked}
          onChange={(e) => setPicked(e.target.value)}
          className="flex-1 rounded-md border border-slate-300 px-2 py-1 dark:border-slate-700 dark:bg-slate-950"
        >
          <option value="">— add a group —</option>
          {available.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={add}
          disabled={!picked}
          className="rounded-md border border-slate-300 px-3 py-1 text-sm hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          Add
        </button>
      </div>
      {value.length === 0 ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          No groups added. At least one group is required for restricted pages.
        </p>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-md border border-slate-300 dark:divide-slate-800 dark:border-slate-800">
          {value.map((a) => (
            <li key={a.groupId} className="flex items-center gap-3 px-3 py-2">
              <span className="flex-1 truncate">
                {groupMap.get(a.groupId)?.name ?? a.groupId.slice(0, 8)}
              </span>
              <label className="flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={a.canEdit}
                  onChange={(e) => setCanEdit(a.groupId, e.target.checked)}
                />
                can edit
              </label>
              <button
                type="button"
                onClick={() => remove(a.groupId)}
                className="text-xs text-rose-600 hover:text-rose-700"
              >
                remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
