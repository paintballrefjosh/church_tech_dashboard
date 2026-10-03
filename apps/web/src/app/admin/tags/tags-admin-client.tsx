"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { TAG_COLORS, type Tag, type TagColor } from "@church/shared";
import { TagBadge } from "@/components/tag-badge";

export function TagsAdminClient({ initial }: { initial: Tag[] }) {
  const [tags, setTags] = useState<Tag[]>(initial);
  const [name, setName] = useState("");
  const [color, setColor] = useState<TagColor>("slate");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    const r = await fetch("/api/tags", { credentials: "same-origin", cache: "no-store" });
    if (r.ok) setTags((await r.json()) as Tag[]);
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/tags", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), color }),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { message?: string | string[] };
        setErr(
          Array.isArray(b.message) ? b.message.join(", ") : (b.message ?? `failed (${r.status})`),
        );
        return;
      }
      setName("");
      setColor("slate");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function destroy(id: string, label: string) {
    if (!confirm(`Delete tag "${label}"? Any assignments will be removed.`)) return;
    const r = await fetch(`/api/tags/${id}`, { method: "DELETE", credentials: "same-origin" });
    if (r.ok) setTags((prev) => prev.filter((t) => t.id !== id));
    else setErr(`Delete failed (${r.status})`);
  }

  async function recolor(t: Tag, c: TagColor) {
    const r = await fetch(`/api/tags/${t.id}`, {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ color: c }),
    });
    if (r.ok) setTags((prev) => prev.map((x) => (x.id === t.id ? { ...x, color: c } : x)));
  }

  return (
    <div className="mt-6 space-y-6">
      <form
        onSubmit={create}
        className="flex flex-wrap items-end gap-2 rounded-md border border-slate-300 p-4 dark:border-slate-800"
      >
        <label className="flex flex-col text-xs">
          <span className="text-slate-500">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="worship, sound, urgent…"
            maxLength={64}
            required
            className="mt-1 w-56 rounded-md border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950"
          />
        </label>
        <label className="flex flex-col text-xs">
          <span className="text-slate-500">Color</span>
          <select
            value={color}
            onChange={(e) => setColor(e.target.value as TagColor)}
            className="mt-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950"
          >
            {TAG_COLORS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={busy || !name.trim()}
          className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          <Plus className="h-4 w-4" aria-hidden /> Create tag
        </button>
        {err ? <span className="text-xs text-rose-600">{err}</span> : null}
      </form>

      {tags.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-700">
          No tags yet. Create your first one above.
        </p>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-md border border-slate-300 dark:divide-slate-800 dark:border-slate-800">
          {tags.map((t) => (
            <li key={t.id} className="flex items-center gap-3 px-3 py-2">
              <TagBadge tag={t} />
              <span className="flex-1 truncate text-xs text-slate-500 dark:text-slate-400">
                created {new Date(t.createdAt).toLocaleDateString()}
              </span>
              <select
                value={t.color}
                onChange={(e) => void recolor(t, e.target.value as TagColor)}
                className="rounded border border-slate-300 px-1.5 py-0.5 text-xs dark:border-slate-700 dark:bg-slate-950"
                aria-label={`Color for ${t.name}`}
              >
                {TAG_COLORS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void destroy(t.id, t.name)}
                aria-label={`Delete ${t.name}`}
                className="text-rose-600 hover:text-rose-700"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
