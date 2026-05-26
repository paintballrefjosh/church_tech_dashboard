"use client";

import { useState, useTransition } from "react";
import { WIKI_VISIBILITIES, type WikiPage, type WikiVisibility } from "@church/shared";
import { AclEditor, type AclState } from "../../acl-editor";

interface GroupBrief {
  id: string;
  name: string;
}

export function EditWikiForm({
  page,
  initialAcl,
  groups,
}: {
  page: WikiPage;
  initialAcl: AclState;
  groups: GroupBrief[];
}) {
  const [pending, startTransition] = useTransition();
  const [visibility, setVisibility] = useState<WikiVisibility>(page.visibility);
  const [acl, setAcl] = useState<AclState>(initialAcl);
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = e.currentTarget;
    const data = new FormData(form);
    const title = String(data.get("title") ?? "").trim();
    const body = String(data.get("body") ?? "");
    const summary = String(data.get("summary") ?? "").trim();
    if (!title) {
      setError("Title is required.");
      return;
    }
    if (visibility === "group" && acl.length === 0) {
      setError("Restricted pages need at least one group.");
      return;
    }
    startTransition(async () => {
      const res = await fetch(`/api/wiki/${page.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title,
          body,
          visibility,
          acl,
          summary: summary || undefined,
        }),
        credentials: "same-origin",
      });
      if (res.ok) {
        window.location.assign(`/wiki/${page.id}`);
        return;
      }
      const r = (await res.json().catch(() => ({}))) as { message?: string };
      setError(r.message ?? `Save failed (${res.status})`);
    });
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-4">
      <label className="block">
        <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Title</span>
        <input
          name="title"
          type="text"
          required
          maxLength={200}
          defaultValue={page.title}
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
        />
      </label>
      <label className="block">
        <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
          Body <span className="text-xs font-normal text-slate-500">(markdown)</span>
        </span>
        <textarea
          name="body"
          rows={20}
          maxLength={200_000}
          defaultValue={page.body}
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm dark:border-slate-700 dark:bg-slate-950"
        />
      </label>
      <label className="block">
        <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
          Edit summary <span className="text-xs font-normal text-slate-500">(optional)</span>
        </span>
        <input
          name="summary"
          type="text"
          maxLength={500}
          placeholder="e.g. fix typo in step 3"
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
        />
      </label>
      <fieldset className="rounded-md border border-slate-200 p-4 dark:border-slate-800">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Visibility
        </legend>
        <div className="space-y-2">
          {WIKI_VISIBILITIES.map((v) => (
            <label key={v} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="visibility"
                value={v}
                checked={visibility === v}
                onChange={() => setVisibility(v)}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium">
                  {v === "public" ? "Public" : "Restricted to groups"}
                </span>
              </span>
            </label>
          ))}
        </div>
        {visibility === "group" ? (
          <div className="mt-4">
            <AclEditor groups={groups} value={acl} onChange={setAcl} />
          </div>
        ) : null}
      </fieldset>
      {error ? (
        <p
          role="alert"
          className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300"
        >
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save changes"}
        </button>
        <a
          href={`/wiki/${page.id}`}
          className="text-sm text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white"
        >
          Cancel
        </a>
      </div>
    </form>
  );
}
