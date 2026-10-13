"use client";

import { useState, useTransition } from "react";
import {
  ATTACHMENT_CUSTOM_EXTENSIONS_SETTING,
  ATTACHMENT_TYPES_SETTING,
  ATTACHMENT_TYPE_CATALOGUE,
  DEFAULT_ATTACHMENT_TYPES,
  MAX_CUSTOM_ATTACHMENT_EXTENSIONS,
  normaliseCustomExtension,
} from "@church/shared";

const GROUPS = ["Images", "Video", "Audio", "Documents", "Text", "Archives"] as const;

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/**
 * Which file types people may upload as attachments (wiki pages, notes, tickets). The checklist comes
 * from a closed catalogue in @church/shared, each type verified against the file's own bytes on upload.
 * "Other file extensions" is free text but unverified, so it is download-only and the dangerous
 * extensions (html, svg, exe, ...) are refused; the same rules run on the server.
 */
export function AttachmentSettings({ allowed, custom }: { allowed: string[]; custom: string[] }) {
  const [saved, setSaved] = useState<string[]>(allowed);
  const [selected, setSelected] = useState<string[]>(allowed);
  const [savedCustom, setSavedCustom] = useState<string[]>(custom);
  const [exts, setExts] = useState<string[]>(custom);
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);
  const [saving, startTransition] = useTransition();
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  function toggle(mime: string, on: boolean) {
    setSelected((prev) => (on ? [...prev, mime] : prev.filter((m) => m !== mime)));
  }

  /** The extensions list with what is typed in the box added to it, or null (with the reason shown) if any is refused. */
  function withDraft(): string[] | null {
    const next = [...exts];
    for (const part of draft.split(/[\s,;]+/).filter(Boolean)) {
      const r = normaliseCustomExtension(part);
      if (!r.ok) {
        setDraftError(r.error);
        return null;
      }
      if (!next.includes(r.ext)) next.push(r.ext);
    }
    if (next.length > MAX_CUSTOM_ATTACHMENT_EXTENSIONS) {
      setDraftError(`At most ${MAX_CUSTOM_ATTACHMENT_EXTENSIONS} custom extensions.`);
      return null;
    }
    return next;
  }

  function addExts() {
    const next = withDraft();
    if (!next) return;
    setExts(next);
    setDraft("");
    setDraftError(null);
  }

  async function post(key: string, value: unknown): Promise<string | null> {
    try {
      const r = await fetch(`/admin/settings/save/${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value }),
        credentials: "same-origin",
      });
      if (r.ok) return null;
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      return j.error ?? `Save failed (${r.status})`;
    } catch {
      return "Save failed: the server could not be reached.";
    }
  }

  function onSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus(null);
    // Text typed but not added yet counts: take it along so it is not silently lost.
    let finalExts = exts;
    if (draft.trim()) {
      const next = withDraft();
      if (!next) return;
      finalExts = next;
      setExts(next);
      setDraft("");
      setDraftError(null);
    }
    startTransition(async () => {
      const value = ATTACHMENT_TYPE_CATALOGUE.map((t) => t.mime).filter((m) => selected.includes(m));
      const failures: string[] = [];
      if (!sameSet(value, saved)) {
        const err = await post(ATTACHMENT_TYPES_SETTING, value);
        if (err) failures.push(err);
        else setSaved(value);
      }
      if (!sameSet(finalExts, savedCustom)) {
        const err = await post(ATTACHMENT_CUSTOM_EXTENSIONS_SETTING, finalExts);
        if (err) failures.push(err);
        else setSavedCustom(finalExts);
      }
      setStatus(
        failures.length > 0
          ? { ok: false, text: failures.join(" ") }
          : { ok: true, text: "Saved. It applies to the next upload." },
      );
    });
  }

  return (
    <section aria-labelledby="attachments-heading" className="mt-6">
      <h2 id="attachments-heading" className="text-lg font-medium">
        Attachments
      </h2>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
        The file types people can upload to wiki pages, notes and tickets. Uploads of the types in the lists are checked
        against the file&apos;s own contents, so a renamed file is refused; other extensions you add are not (see
        below). Unticking images or video also stops them being pasted into the editor.
      </p>
      <form
        onSubmit={onSave}
        className="mt-4 space-y-5 rounded-md border border-slate-300 p-4 dark:border-slate-800"
        data-testid="attachment-settings"
      >
        {GROUPS.map((group) => (
          <fieldset key={group} className="text-sm">
            <legend className="font-medium">{group}</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {ATTACHMENT_TYPE_CATALOGUE.filter((t) => t.group === group).map((t) => (
                <label key={t.mime} className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={selected.includes(t.mime)}
                    onChange={(e) => toggle(t.mime, e.target.checked)}
                    className="mt-0.5 h-4 w-4 accent-brand-600"
                  />
                  <span>
                    {t.label}
                    <span className="block text-xs text-slate-500 dark:text-slate-400">{t.ext}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        ))}
        <fieldset className="text-sm" data-testid="custom-extensions">
          <legend className="font-medium">Other file extensions</legend>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            For types that are not in the lists above, such as .dwg or .vsdx. These are allowed by file name only: the
            dashboard cannot check what is inside them, so they are always stored as a plain download and never shown
            in the browser. Programs and web pages (.exe, .html, .svg, .js and similar) can never be allowed.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {exts.map((x) => (
              <span
                key={x}
                className="inline-flex items-center gap-1 rounded-full border border-slate-300 bg-slate-50 py-0.5 pl-2.5 pr-1 text-xs dark:border-slate-700 dark:bg-slate-900"
              >
                .{x}
                <button
                  type="button"
                  aria-label={`Remove .${x}`}
                  onClick={() => setExts((prev) => prev.filter((e) => e !== x))}
                  className="rounded-full px-1.5 text-slate-500 hover:bg-slate-200 hover:text-slate-900 dark:hover:bg-slate-700 dark:hover:text-slate-100"
                >
                  &times;
                </button>
              </span>
            ))}
            {exts.length === 0 ? <span className="text-xs text-slate-500 dark:text-slate-400">None added.</span> : null}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setDraftError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addExts();
                }
              }}
              placeholder="dwg, vsdx"
              aria-label="Add file extensions"
              autoComplete="off"
              spellCheck={false}
              className="w-56 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600 dark:border-slate-700 dark:bg-slate-900"
            />
            <button
              type="button"
              onClick={addExts}
              disabled={!draft.trim()}
              className="rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              Add
            </button>
          </div>
          {draftError ? (
            <p role="alert" className="mt-1 text-xs text-rose-600 dark:text-rose-400">
              {draftError}
            </p>
          ) : null}
        </fieldset>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Office files can carry macros. The dashboard never opens them: only images are shown in the browser, every
          other type downloads as a file.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={saving || (sameSet(selected, saved) && sameSet(exts, savedCustom) && !draft.trim())}
            className="rounded-md bg-brand-600 px-4 py-2 text-sm text-white hover:bg-brand-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save attachment types"}
          </button>
          <button
            type="button"
            onClick={() => {
              setSelected([...DEFAULT_ATTACHMENT_TYPES]);
              setExts([]);
            }}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            Restore the defaults
          </button>
          <span role="status" className="text-sm">
            {status ? (
              <span className={status.ok ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}>
                {status.text}
              </span>
            ) : null}
          </span>
        </div>
      </form>
    </section>
  );
}
