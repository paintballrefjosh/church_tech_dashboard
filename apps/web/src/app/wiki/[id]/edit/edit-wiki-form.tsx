"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  WIKI_VISIBILITIES,
  type Attachment,
  type WikiPage,
  type WikiVisibility,
} from "@church/shared";
import { AclEditor, type AclState } from "../../acl-editor";
import { TagPicker } from "@/components/tag-picker";
import { type TagLike } from "@/components/tag-badge";
import { AttachmentList } from "@/components/attachment-list";
import { WikiBodyEditor, type WikiBodyEditorHandle } from "@/components/wiki-body-editor";
import { WikiLocationPicker, type WikiLocation } from "../../wiki-location-picker";

interface GroupBrief {
  id: string;
  name: string;
}

/**
 * Build the markdown snippet that embeds an attachment in the body. Images,
 * videos and audio render inline via the Markdown component's `img` override
 * (the `?t=` flag tells it which element to emit). Anything else — PDFs,
 * zips, plain text, JSON — has no inline preview, so we drop it as a plain
 * link the user can click in the rendered page.
 */
function attachmentSnippet(pageId: string, a: Attachment): string {
  const url = `/api/wiki/${pageId}/attachments/${a.id}`;
  const safeName = a.filename.replace(/[\[\]()]/g, "");
  if (a.contentType.startsWith("image/")) return `![${safeName}](${url})`;
  if (a.contentType.startsWith("video/")) return `![${safeName}](${url}?t=video)`;
  if (a.contentType.startsWith("audio/")) return `![${safeName}](${url}?t=audio)`;
  return `[${safeName}](${url})`;
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
  const [location, setLocation] = useState<WikiLocation>({
    parentId: page.parentId,
    parentFolderId: page.parentFolderId,
  });
  const [error, setError] = useState<string | null>(null);
  const [tags, setTags] = useState<TagLike[]>([]);
  const [body, setBody] = useState<string>(page.body);
  // Bumped after an editor-side upload so the AttachmentList re-fetches and
  // shows the file the user just dropped/pasted into the body.
  const [attachmentsVersion, setAttachmentsVersion] = useState(0);
  const editorRef = useRef<WikiBodyEditorHandle>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // Tags load lazily from the dedicated endpoint so the wiki update payload
  // doesn't have to carry them. The picker writes back immediately on change
  // (separate from the form's "Save changes") because tag assignments are
  // their own semantic operation.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await fetch(`/api/tags/for/wiki_page/${page.id}`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!r.ok || cancelled) return;
      setTags((await r.json()) as TagLike[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [page.id]);

  async function saveTags(next: TagLike[]) {
    setTags(next);
    await fetch(`/api/tags/for/wiki_page/${page.id}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tagIds: next.map((t) => t.id) }),
    });
  }

  /**
   * Splice an attachment embed at the editor's current caret. AttachmentList's
   * "+ Insert" button drives this; the editor's own paste/drop path uses
   * uploadAttachment() below (which already inserts).
   */
  function insertAttachment(a: Attachment) {
    editorRef.current?.insertAtCaret(attachmentSnippet(page.id, a));
  }

  /**
   * onUpload bridge for the WikiBodyEditor — POSTs the file to the wiki's
   * attachments endpoint and returns the markdown snippet the editor splices
   * at the caret. Bumps `attachmentsVersion` so AttachmentList re-fetches and
   * shows the new file in its grid.
   */
  async function uploadAttachment(file: File): Promise<string | null> {
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetch(`/api/wiki/${page.id}/attachments`, {
      method: "POST",
      body: fd,
      credentials: "same-origin",
    });
    if (!r.ok) return null;
    const a = (await r.json()) as Attachment;
    setAttachmentsVersion((v) => v + 1);
    return attachmentSnippet(page.id, a);
  }

  function submitForm() {
    formRef.current?.requestSubmit();
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = e.currentTarget;
    const data = new FormData(form);
    const title = String(data.get("title") ?? "").trim();
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
          parentId: location.parentId,
          parentFolderId: location.parentFolderId,
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
    <form ref={formRef} onSubmit={onSubmit} className="mt-6 grid gap-6 md:grid-cols-[16rem_1fr]">
      {/* Main column comes first in the DOM so mobile (single-column) stacking
          puts the fields ahead of Save/Cancel; md:order-first below pulls the
          menu column back to the left visually once the two-column grid kicks
          in. */}
      <div className="space-y-4">
        <label className="block">
          <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Title</span>
          <input
            name="title"
            type="text"
            required
            maxLength={200}
            defaultValue={page.title}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-base dark:border-slate-700 dark:bg-slate-950"
          />
        </label>
        <WikiLocationPicker value={location} onChange={setLocation} excludePageId={page.id} />
        <div className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
            Body
          </span>
          <WikiBodyEditor
            ref={editorRef}
            name="body"
            value={body}
            onChange={setBody}
            onUpload={uploadAttachment}
            onSubmitShortcut={submitForm}
            placeholder={"Start typing… use the toolbar above, or type '/' on a new line for blocks. Drop or paste images to upload."}
          />
        </div>
        <fieldset className="rounded-md border border-slate-300 p-4 dark:border-slate-800">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Attachments
          </legend>
          <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
            Drop a file into the editor to upload + embed in one step, or use the list below to
            manage existing files. The <strong>+</strong> button inserts an embed at your cursor.
          </p>
          {/* `key={attachmentsVersion}` remounts the list (and re-fetches) after
              an editor-side paste/drop upload so the new file appears here too. */}
          <AttachmentList
            key={attachmentsVersion}
            baseUrl={`/api/wiki/${page.id}/attachments`}
            canEdit
            layout="row"
            onInsert={insertAttachment}
            onUploaded={insertAttachment}
          />
        </fieldset>
      </div>
      {/* Menu column: save/cancel + the metadata fields that aren't the page
          body itself. Sticks in place on scroll (md:self-start keeps it from
          stretching to the row height, which is what lets sticky work) so
          it's always reachable while editing a long page. */}
      <aside className="space-y-4 md:sticky md:top-4 md:order-first md:max-h-[calc(100vh-2rem)] md:self-start md:overflow-y-auto">
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
        {error ? (
          <p
            role="alert"
            className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300"
          >
            {error}
          </p>
        ) : null}
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
        <fieldset className="rounded-md border border-slate-300 p-4 dark:border-slate-800">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Tags
          </legend>
          <TagPicker value={tags} onChange={(next) => void saveTags(next)} />
        </fieldset>
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
      </aside>
    </form>
  );
}
