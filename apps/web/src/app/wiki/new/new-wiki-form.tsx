"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import { WIKI_VISIBILITIES, renderWikiTemplate, type WikiVisibility } from "@church/shared";
import { AclEditor, type AclState } from "../acl-editor";
import { WikiBodyEditor } from "@/components/wiki-body-editor";
import { WikiLocationPicker, type WikiLocation } from "../wiki-location-picker";

interface GroupBrief {
  id: string;
  name: string;
}

export interface TemplateChoice {
  id: string;
  name: string;
  description: string;
  body: string;
  builtIn: boolean;
}

/** Today as YYYY-MM-DD in the browser's own zone, for {{date}} in a template. */
function today(): string {
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

export function NewWikiForm({
  groups,
  templates,
  author,
}: {
  groups: GroupBrief[];
  templates: TemplateChoice[];
  author: string;
}) {
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [visibility, setVisibility] = useState<WikiVisibility>("public");
  const [acl, setAcl] = useState<AclState>([]);
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState<string>("");
  // Pre-filled from the tree sidebar's "New page here" / "New subpage here"
  // actions (?parentFolderId=… / ?parentId=…); otherwise root.
  const [location, setLocation] = useState<WikiLocation>(() => ({
    parentId: searchParams.get("parentId"),
    parentFolderId: searchParams.get("parentFolderId"),
  }));
  const formRef = useRef<HTMLFormElement>(null);
  const [templateId, setTemplateId] = useState("");
  const templateApplied = useRef(false);

  function applyTemplate(id: string) {
    const t = templates.find((x) => x.id === id);
    if (!t) {
      setTemplateId("");
      return;
    }
    if (body.trim() && !confirm("Replace what you have written with this template?")) return;
    setBody(renderWikiTemplate(t.body, { date: today(), author }));
    setTemplateId(t.id);
  }

  // /wiki/new?template=<id> (from the templates screen) starts with that template filled in.
  useEffect(() => {
    if (templateApplied.current) return;
    templateApplied.current = true;
    const wanted = searchParams.get("template");
    if (wanted && templates.some((t) => t.id === wanted)) applyTemplate(wanted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function submitForm() {
    formRef.current?.requestSubmit();
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = e.currentTarget;
    const data = new FormData(form);
    const title = String(data.get("title") ?? "").trim();
    if (!title) {
      setError("Title is required.");
      return;
    }
    if (visibility === "group" && acl.length === 0) {
      setError("Restricted pages need at least one group.");
      return;
    }
    startTransition(async () => {
      const res = await fetch("/api/wiki", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title,
          body,
          visibility,
          acl,
          parentId: location.parentId,
          parentFolderId: location.parentFolderId,
        }),
        credentials: "same-origin",
      });
      if (res.ok) {
        const page = (await res.json()) as { id: string };
        window.location.assign(`/wiki/${page.id}`);
        return;
      }
      const r = (await res.json().catch(() => ({}))) as { message?: string };
      setError(r.message ?? `Couldn't create page (${res.status})`);
    });
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} className="mt-6 space-y-4">
      {templates.length > 0 ? (
        <div className="block">
          <label htmlFor="wiki-template" className="text-sm font-medium text-slate-700 dark:text-slate-300">
            Start from
          </label>
          <select
            id="wiki-template"
            value={templateId}
            onChange={(e) => applyTemplate(e.target.value)}
            data-testid="template-pick"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
          >
            <option value="">A blank page</option>
            <optgroup label="Built in">
              {templates
                .filter((t) => t.builtIn)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </optgroup>
            {templates.some((t) => !t.builtIn) ? (
              <optgroup label="Saved by your admins">
                {templates
                  .filter((t) => !t.builtIn)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
              </optgroup>
            ) : null}
          </select>
          {templateId ? (
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {templates.find((t) => t.id === templateId)?.description}
            </p>
          ) : null}
        </div>
      ) : null}
      <label className="block">
        <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Title</span>
        <input
          name="title"
          type="text"
          required
          maxLength={200}
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-base dark:border-slate-700 dark:bg-slate-950"
          placeholder="What's this page about?"
        />
      </label>
      <WikiLocationPicker value={location} onChange={setLocation} />
      <div className="block">
        <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
          Body
        </span>
        {/* No onUpload until the page exists — the editor surfaces the
            constraint inline when the user tries to drop or click the image
            button. They can attach files from the page after creating it. */}
        <WikiBodyEditor
          name="body"
          value={body}
          onChange={setBody}
          onSubmitShortcut={submitForm}
          placeholder={"# Heading\n\nUse the toolbar, or type '/' on a new line for blocks. **bold**, _italics_, [links](https://example.com), code, tables."}
        />
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        You can attach files (images, video, PDFs, …) and embed them in the body once the page is created.
      </p>
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
          {pending ? "Creating…" : "Create page"}
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
