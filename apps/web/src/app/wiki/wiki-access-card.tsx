"use client";

import { useId, useState } from "react";
import { normaliseWikiAcl, type WikiVisibility } from "@lampstand/shared";
import { DialogFrame } from "@/components/modal";
import { WikiAccessEditor, type AclState, type GroupBrief } from "./wiki-access-editor";

const HINT = "text-xs text-slate-500 dark:text-slate-400";
// Group names can be one long word: let them break rather than widen the card.
const WRAP = "[overflow-wrap:anywhere]";

/**
 * The page menu's "Access" card: a short summary of who can read and who can edit, and a button that opens
 * `WikiAccessEditor` in a dialog. The dialog works on a draft: Apply hands it to the page form (which saves it with the
 * page, like the rest of the form), Cancel or Escape throws it away.
 */
export function WikiAccessCard({
  groups,
  visibility,
  acl,
  onApply,
}: {
  groups: GroupBrief[];
  visibility: WikiVisibility;
  acl: AclState;
  onApply: (visibility: WikiVisibility, acl: AclState) => void;
}) {
  const [open, setOpen] = useState(false);
  const nameOf = (id: string) => groups.find((g) => g.id === id)?.name ?? id.slice(0, 8);
  const saved = normaliseWikiAcl(visibility, acl);
  const readers = visibility === "group" ? saved.map((a) => nameOf(a.groupId)) : [];
  const editors = saved.filter((a) => a.canEdit).map((a) => nameOf(a.groupId));

  return (
    <fieldset className="min-w-0 rounded-md border border-slate-300 p-4 dark:border-slate-800">
      <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        Access
      </legend>
      <dl className="space-y-3 text-sm">
        <div>
          <dt className={HINT}>Who can read</dt>
          <dd className={WRAP} data-testid="access-read-summary">
            {visibility === "public"
              ? "Everyone"
              : readers.length > 0
                ? readers.join(", ")
                : "Only the owner and Wiki moderators"}
          </dd>
        </div>
        <div>
          <dt className={HINT}>Who can edit</dt>
          <dd className={WRAP} data-testid="access-edit-summary">
            {editors.length > 0 ? `${editors.join(", ")}, the owner and Wiki admins` : "The owner and Wiki admins"}
          </dd>
        </div>
      </dl>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
      >
        Edit access
      </button>
      {open ? (
        <AccessDialog
          groups={groups}
          initialVisibility={visibility}
          initialAcl={acl}
          onCancel={() => setOpen(false)}
          onApply={(v, a) => {
            onApply(v, a);
            setOpen(false);
          }}
        />
      ) : null}
    </fieldset>
  );
}

function AccessDialog({
  groups,
  initialVisibility,
  initialAcl,
  onCancel,
  onApply,
}: {
  groups: GroupBrief[];
  initialVisibility: WikiVisibility;
  initialAcl: AclState;
  onCancel: () => void;
  onApply: (visibility: WikiVisibility, acl: AclState) => void;
}) {
  const titleId = useId();
  const [visibility, setVisibility] = useState<WikiVisibility>(initialVisibility);
  const [acl, setAcl] = useState<AclState>(initialAcl);
  // The page form refuses a restricted page with no groups, so say so here rather than after Save.
  const empty = visibility === "group" && acl.length === 0;

  return (
    <DialogFrame
      onClose={onCancel}
      labelledBy={titleId}
      closeOnBackdrop={false}
      testId="wiki-access-dialog"
      className="max-h-[90vh] w-full max-w-3xl overflow-y-auto overflow-x-hidden rounded-lg border border-slate-300 bg-white p-5 shadow-xl dark:border-slate-700 dark:bg-slate-900"
    >
      <h2 id={titleId} className="mb-1 text-base font-semibold">
        Who can read and edit this page
      </h2>
      <p className={`mb-4 ${HINT}`}>Reading and editing are separate: anyone who can edit a restricted page can read it too.</p>
      <WikiAccessEditor
        groups={groups}
        visibility={visibility}
        onVisibilityChange={setVisibility}
        acl={acl}
        onAclChange={setAcl}
      />
      <div className="mt-5 flex flex-wrap items-center justify-end gap-3">
        {empty ? (
          <p role="status" className="mr-auto text-xs text-amber-800 dark:text-amber-300">
            Add at least one group, or choose Everyone.
          </p>
        ) : null}
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={empty}
          onClick={() => onApply(visibility, normaliseWikiAcl(visibility, acl))}
          className="rounded-md bg-brand-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
        >
          Apply
        </button>
      </div>
    </DialogFrame>
  );
}
