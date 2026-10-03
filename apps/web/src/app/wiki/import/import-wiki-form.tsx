"use client";

import { useRef, useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import { WIKI_VISIBILITIES, type WikiVisibility } from "@church/shared";
import { AclEditor, type AclState } from "../acl-editor";
import { WikiLocationPicker, type WikiLocation } from "../wiki-location-picker";

interface GroupBrief {
  id: string;
  name: string;
}

const ACCEPT = ".docx,.txt,.pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,application/pdf";

/**
 * Mirrors NewWikiForm's shape (title / location / visibility / ACL) but
 * swaps the body editor for a file picker — the body comes from converting
 * whatever file is uploaded, not typed in directly.
 */
export function ImportWikiForm({ groups }: { groups: GroupBrief[] }) {
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [visibility, setVisibility] = useState<WikiVisibility>("public");
  const [acl, setAcl] = useState<AclState>([]);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [location, setLocation] = useState<WikiLocation>(() => ({
    parentId: searchParams.get("parentId"),
    parentFolderId: searchParams.get("parentFolderId"),
  }));
  const formRef = useRef<HTMLFormElement>(null);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = e.currentTarget;
    const data = new FormData(form);
    const title = String(data.get("title") ?? "").trim();
    if (!file) {
      setError("Choose a file to import.");
      return;
    }
    if (visibility === "group" && acl.length === 0) {
      setError("Restricted pages need at least one group.");
      return;
    }
    const qs = new URLSearchParams();
    if (title) qs.set("title", title);
    qs.set("visibility", visibility);
    if (visibility === "group" && acl.length > 0) qs.set("acl", JSON.stringify(acl));
    if (location.parentId) qs.set("parentId", location.parentId);
    if (location.parentFolderId) qs.set("parentFolderId", location.parentFolderId);

    startTransition(async () => {
      const body = new FormData();
      body.set("file", file);
      const res = await fetch(`/api/wiki/import?${qs.toString()}`, {
        method: "POST",
        body,
        credentials: "same-origin",
      });
      if (res.ok) {
        const page = (await res.json()) as { id: string };
        // Land on the editor, not the read view — an import is a starting
        // draft that's expected to need a cleanup pass.
        window.location.assign(`/wiki/${page.id}/edit`);
        return;
      }
      const r = (await res.json().catch(() => ({}))) as { message?: string };
      setError(r.message ?? `Couldn't import file (${res.status})`);
    });
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} className="mt-6 space-y-4">
      <label className="block">
        <span className="text-sm font-medium text-slate-700 dark:text-slate-300">File</span>
        <input
          name="file"
          type="file"
          required
          accept={ACCEPT}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="mt-1 block w-full text-sm text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-brand-600 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-brand-700 dark:text-slate-300"
        />
        <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
          Word (.docx), plain text (.txt), or PDF. Headings, lists, bold/italic, tables and
          embedded images convert automatically for .docx. PDF import is best-effort text
          only — no formatting or images.
        </span>
      </label>
      <label className="block">
        <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
          Title <span className="font-normal text-slate-400">(defaults to the filename)</span>
        </span>
        <input
          name="title"
          type="text"
          maxLength={200}
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-base dark:border-slate-700 dark:bg-slate-950"
          placeholder={file?.name.replace(/\.(docx|txt|pdf)$/i, "") ?? "What's this page about?"}
        />
      </label>
      <WikiLocationPicker value={location} onChange={setLocation} />
      <fieldset className="rounded-md border border-slate-300 p-4 dark:border-slate-800">
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
                <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
                  {v === "public"
                    ? "Any signed-in user can read this page."
                    : "Only members of the groups you list can read or edit."}
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
          {pending ? "Importing…" : "Import"}
        </button>
        <a
          href="/wiki"
          className="text-sm text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white"
        >
          Cancel
        </a>
      </div>
    </form>
  );
}
