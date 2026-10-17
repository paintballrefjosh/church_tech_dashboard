"use client";

import { useState } from "react";
import Link from "next/link";
import { Pencil, Plus, Trash2 } from "lucide-react";
import {
  WIKI_TEMPLATE_DESCRIPTION_MAX,
  WIKI_TEMPLATE_NAME_MAX,
  type WikiStarterTemplate,
  type WikiTemplate,
} from "@church/shared";
import { WikiBodyEditor } from "@/components/wiki-body-editor";

const API = "/api/v1/wiki/templates";
const field =
  "w-full rounded-md border border-slate-300 bg-transparent px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950";

async function messageOf(res: Response, fallback: string): Promise<string> {
  const b = (await res.json().catch(() => ({}))) as { message?: unknown };
  return typeof b.message === "string" ? b.message : `${fallback} (${res.status})`;
}

export function TemplatesClient({
  builtIn,
  initial,
  canWrite,
}: {
  builtIn: WikiStarterTemplate[];
  initial: WikiTemplate[];
  canWrite: boolean;
}) {
  const [saved, setSaved] = useState(initial);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function start(t: WikiTemplate | null) {
    setErr(null);
    setEditing(t ? t.id : "new");
    setName(t?.name ?? "");
    setDescription(t?.description ?? "");
    setBody(t?.body ?? "");
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const creating = editing === "new";
      const res = await fetch(creating ? API : `${API}/${editing}`, {
        method: creating ? "POST" : "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, description, body }),
      });
      if (!res.ok) {
        setErr(await messageOf(res, "Could not save"));
        return;
      }
      const row = (await res.json()) as WikiTemplate;
      setSaved((prev) => (creating ? [...prev, row] : prev.map((t) => (t.id === row.id ? row : t))).sort((a, b) => a.name.localeCompare(b.name)));
      setEditing(null);
    } finally {
      setBusy(false);
    }
  }

  async function remove(t: WikiTemplate) {
    if (!confirm(`Delete the template "${t.name}"? Pages made from it are not affected.`)) return;
    setErr(null);
    const res = await fetch(`${API}/${t.id}`, { method: "DELETE", credentials: "same-origin" });
    if (res.ok) setSaved((prev) => prev.filter((x) => x.id !== t.id));
    else setErr(await messageOf(res, "Could not delete"));
  }

  return (
    <div className="mt-6 space-y-6">
      {canWrite && editing === null ? (
        <button
          type="button"
          onClick={() => start(null)}
          data-testid="template-new"
          className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
        >
          <Plus className="h-4 w-4" aria-hidden /> New template
        </button>
      ) : null}
      {!canWrite ? (
        <p className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-600 dark:border-slate-700 dark:text-slate-400">
          You can start a page from any of these. Keeping the list takes wiki admin access.
        </p>
      ) : null}

      {editing !== null ? (
        <form onSubmit={save} className="space-y-3 rounded-md border border-slate-300 p-4 dark:border-slate-800" data-testid="template-form">
          <label className="block text-xs text-slate-500">
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={WIKI_TEMPLATE_NAME_MAX}
              className={`mt-1 ${field}`}
              data-testid="template-name"
            />
          </label>
          <label className="block text-xs text-slate-500">
            What it is for (shown in the list)
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={WIKI_TEMPLATE_DESCRIPTION_MAX}
              className={`mt-1 ${field}`}
              data-testid="template-description"
            />
          </label>
          <div>
            <span className="mb-1 block text-xs text-slate-500">Outline</span>
            <WikiBodyEditor name="body" value={body} onChange={setBody} ariaLabel="Template outline" />
          </div>
          {err ? (
            <p role="alert" className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300">
              {err}
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={busy || !name.trim() || !body.trim()}
              data-testid="template-save"
              className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {busy ? "Saving..." : "Save"}
            </button>
            <button type="button" onClick={() => setEditing(null)} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700">
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      {err && editing === null ? (
        <p role="alert" className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300">
          {err}
        </p>
      ) : null}

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Saved by your admins</h2>
        {saved.length === 0 ? (
          <p className="rounded-md border border-dashed border-slate-300 p-4 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
            Nothing saved yet.{canWrite ? " Add one, or use Save as template on any page." : ""}
          </p>
        ) : (
          <ul className="divide-y divide-slate-200 rounded-md border border-slate-300 dark:divide-slate-800 dark:border-slate-800" data-testid="template-list">
            {saved.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid="template-row">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{t.name}</div>
                  {t.description ? <div className="truncate text-xs text-slate-500 dark:text-slate-400">{t.description}</div> : null}
                </div>
                <Link href={`/wiki/new?template=${t.id}`} className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-900">
                  Use
                </Link>
                {canWrite ? (
                  <>
                    <button type="button" onClick={() => start(t)} aria-label={`Edit ${t.name}`} className="rounded-md border border-slate-300 p-1.5 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-900">
                      <Pencil className="h-3.5 w-3.5" aria-hidden />
                    </button>
                    <button type="button" onClick={() => void remove(t)} aria-label={`Delete ${t.name}`} className="rounded-md border border-rose-300 p-1.5 text-rose-700 hover:bg-rose-50 dark:border-rose-700 dark:text-rose-300 dark:hover:bg-rose-950">
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Built in</h2>
        <ul className="divide-y divide-slate-200 rounded-md border border-slate-300 dark:divide-slate-800 dark:border-slate-800">
          {builtIn.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{t.name}</div>
                <div className="truncate text-xs text-slate-500 dark:text-slate-400">{t.description}</div>
              </div>
              <Link href={`/wiki/new?template=${encodeURIComponent(t.id)}`} className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-900">
                Use
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
