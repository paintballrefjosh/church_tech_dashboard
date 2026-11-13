"use client";

import { useId, useState } from "react";
import {
  addWikiEditor,
  addWikiReader,
  removeWikiEditor,
  removeWikiReader,
  wikiEditorGroupIds,
  type WikiAclEntry,
  type WikiVisibility,
} from "@lampstand/shared";

export interface GroupBrief {
  id: string;
  name: string;
}

export type AclState = WikiAclEntry[];

const LEGEND =
  "px-1 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400";
const FIELDSET = "min-w-0 rounded-md border border-slate-300 p-4 dark:border-slate-800";
const HINT = "text-xs text-slate-500 dark:text-slate-400";

/**
 * Who can read a page and who can edit it, as two lists. Reading is "everyone" or "specific groups"; editing is the
 * owner and Wiki admins plus any groups added here, on a public page as well as a restricted one. How the two share
 * the one stored list (a group row = a reader, `canEdit` = an editor too) is in packages/shared/src/wiki-access.ts.
 *
 * Everything is `min-w-0`: a fieldset and a flex child size to their content by default, so a long group name would
 * push the Add button out of the card and make the page scroll sideways.
 */
export function WikiAccessEditor({
  groups,
  visibility,
  onVisibilityChange,
  acl,
  onAclChange,
}: {
  groups: GroupBrief[];
  visibility: WikiVisibility;
  onVisibilityChange: (next: WikiVisibility) => void;
  acl: AclState;
  onAclChange: (next: AclState) => void;
}) {
  const radioName = useId();
  const nameOf = (id: string) => groups.find((g) => g.id === id)?.name ?? id.slice(0, 8);
  const restricted = visibility === "group";
  const editorIds = new Set(wikiEditorGroupIds(acl));

  return (
    <div className="grid min-w-0 gap-4 md:grid-cols-2">
      <fieldset className={FIELDSET}>
        <legend className={LEGEND}>Who can read this page</legend>
        <div className="space-y-2">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name={radioName}
              checked={!restricted}
              onChange={() => onVisibilityChange("public")}
              className="mt-0.5"
            />
            <span className="min-w-0">
              <span className="font-medium">Everyone</span>
              <span className={`ml-2 ${HINT}`}>Any signed-in user who can use the Wiki.</span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name={radioName}
              checked={restricted}
              onChange={() => onVisibilityChange("group")}
              className="mt-0.5"
            />
            <span className="min-w-0">
              <span className="font-medium">Restricted to groups</span>
              <span className={`ml-2 ${HINT}`}>
                Only the groups below, the owner, and Wiki moderators and admins.
              </span>
            </span>
          </label>
        </div>
        {restricted ? (
          <div className="mt-4 min-w-0 space-y-3">
            <GroupAdder
              label="Add a group that can read this page"
              groups={groups.filter((g) => !acl.some((a) => a.groupId === g.id))}
              onAdd={(id) => onAclChange(addWikiReader(acl, id))}
            />
            <GroupList
              empty="No groups yet. Add at least one, or only the owner and Wiki moderators can read it."
              rows={acl.map((a) => ({
                id: a.groupId,
                name: nameOf(a.groupId),
                note: a.canEdit ? "can also edit" : null,
                removeLabel: `Remove ${nameOf(a.groupId)} from readers${a.canEdit ? " (it will lose edit access too)" : ""}`,
              }))}
              onRemove={(id) => onAclChange(removeWikiReader(acl, id))}
            />
          </div>
        ) : null}
      </fieldset>

      <fieldset className={FIELDSET}>
        <legend className={LEGEND}>Who can edit this page</legend>
        <p className={HINT}>
          The owner and Wiki admins can always edit it. Add groups below to let their members edit too.
          {restricted ? " A group that can edit can also read the page." : null}
        </p>
        <div className="mt-3 min-w-0 space-y-3">
          <GroupAdder
            label="Add a group that can edit this page"
            groups={groups.filter((g) => !editorIds.has(g.id))}
            onAdd={(id) => onAclChange(addWikiEditor(acl, id))}
          />
          <GroupList
            empty="No groups yet: only the owner and Wiki admins can edit."
            rows={groups
              .filter((g) => editorIds.has(g.id))
              .concat(
                // A group that was deleted after being added still shows, so it can be removed.
                [...editorIds].filter((id) => !groups.some((g) => g.id === id)).map((id) => ({ id, name: id.slice(0, 8) })),
              )
              .map((g) => ({
                id: g.id,
                name: g.name,
                note: null,
                removeLabel: `Remove ${g.name} from editors`,
              }))}
            onRemove={(id) => onAclChange(removeWikiEditor(visibility, acl, id))}
          />
        </div>
      </fieldset>

      {groups.length === 0 ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300 md:col-span-2">
          No groups available. Create one in Admin first, then it can be given read or edit access here.
        </p>
      ) : null}
    </div>
  );
}

/** A drop-down of the groups not yet listed and an Add button, which stay on one line however long a name is. */
function GroupAdder({
  label,
  groups,
  onAdd,
}: {
  label: string;
  groups: GroupBrief[];
  onAdd: (groupId: string) => void;
}) {
  const [picked, setPicked] = useState("");
  return (
    <div className="flex min-w-0 gap-2">
      <select
        aria-label={label}
        value={picked}
        onChange={(e) => setPicked(e.target.value)}
        className="min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-950"
      >
        <option value="">Add a group...</option>
        {groups.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={!picked}
        onClick={() => {
          onAdd(picked);
          setPicked("");
        }}
        className="shrink-0 rounded-md border border-slate-300 px-3 py-1 text-sm hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
      >
        Add
      </button>
    </div>
  );
}

function GroupList({
  rows,
  empty,
  onRemove,
}: {
  rows: Array<{ id: string; name: string; note: string | null; removeLabel: string }>;
  empty: string;
  onRemove: (groupId: string) => void;
}) {
  if (rows.length === 0) return <p className={HINT}>{empty}</p>;
  return (
    <ul className="divide-y divide-slate-200 rounded-md border border-slate-300 dark:divide-slate-800 dark:border-slate-800">
      {rows.map((r) => (
        <li key={r.id} className="flex min-w-0 items-center gap-3 px-3 py-1.5 text-sm">
          <span className="min-w-0 flex-1 truncate" title={r.name}>
            {r.name}
          </span>
          {r.note ? <span className={`shrink-0 ${HINT}`}>{r.note}</span> : null}
          <button
            type="button"
            aria-label={r.removeLabel}
            onClick={() => onRemove(r.id)}
            className="shrink-0 rounded px-1.5 py-0.5 text-xs text-rose-700 hover:bg-rose-50 hover:text-rose-800 dark:text-rose-400 dark:hover:bg-rose-950"
          >
            remove
          </button>
        </li>
      ))}
    </ul>
  );
}
