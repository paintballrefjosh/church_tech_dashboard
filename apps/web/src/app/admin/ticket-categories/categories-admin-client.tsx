"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
  TICKET_CATEGORY_COLORS,
  type TicketCategory,
  type TicketCategoryColor,
} from "@church/shared";
import { TagBadge } from "@/components/tag-badge";

export function CategoriesAdminClient({
  initial,
  canWrite,
}: {
  initial: TicketCategory[];
  canWrite: boolean;
}) {
  const [categories, setCategories] = useState<TicketCategory[]>(initial);
  const [name, setName] = useState("");
  const [color, setColor] = useState<TicketCategoryColor>("slate");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    const r = await fetch("/api/ticket-categories", {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (r.ok) setCategories((await r.json()) as TicketCategory[]);
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/ticket-categories", {
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
    if (!confirm(`Delete category "${label}"? Any assignments will be removed.`)) return;
    const r = await fetch(`/api/ticket-categories/${id}`, {
      method: "DELETE",
      credentials: "same-origin",
    });
    if (r.ok) setCategories((prev) => prev.filter((c) => c.id !== id));
    else setErr(`Delete failed (${r.status})`);
  }

  async function rename(c: TicketCategory, next: string) {
    const trimmed = next.trim();
    if (!trimmed || trimmed === c.name) return;
    const r = await fetch(`/api/ticket-categories/${c.id}`, {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: trimmed }),
    });
    if (r.ok) {
      setCategories((prev) =>
        prev.map((x) => (x.id === c.id ? { ...x, name: trimmed } : x)),
      );
    } else {
      const b = (await r.json().catch(() => ({}))) as { message?: string };
      setErr(b.message ?? `Rename failed (${r.status})`);
    }
  }

  async function recolor(c: TicketCategory, next: TicketCategoryColor) {
    const r = await fetch(`/api/ticket-categories/${c.id}`, {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ color: next }),
    });
    if (r.ok) {
      setCategories((prev) =>
        prev.map((x) => (x.id === c.id ? { ...x, color: next } : x)),
      );
    }
  }

  if (!canWrite) {
    return (
      <p className="mt-6 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
        You don't have the <code className="font-mono">tickets:categories:admin</code> permission,
        so this page is read-only.
      </p>
    );
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
            placeholder="Hardware, Facilities, AV…"
            maxLength={64}
            required
            className="mt-1 w-56 rounded-md border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950"
          />
        </label>
        <label className="flex flex-col text-xs">
          <span className="text-slate-500">Color</span>
          <select
            value={color}
            onChange={(e) => setColor(e.target.value as TicketCategoryColor)}
            className="mt-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950"
          >
            {TICKET_CATEGORY_COLORS.map((c) => (
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
          <Plus className="h-4 w-4" aria-hidden /> Create category
        </button>
        {err ? <span className="text-xs text-rose-600">{err}</span> : null}
      </form>

      {categories.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-700">
          No categories yet. Create your first one above.
        </p>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-md border border-slate-300 dark:divide-slate-800 dark:border-slate-800">
          {categories.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
              <TagBadge tag={c} />
              <input
                defaultValue={c.name}
                maxLength={64}
                aria-label={`Rename ${c.name}`}
                onBlur={(e) => void rename(c, e.target.value)}
                className="flex-1 min-w-[10rem] rounded border border-transparent bg-transparent px-1.5 py-0.5 text-sm hover:border-slate-300 focus:border-slate-400 focus:outline-none dark:hover:border-slate-700 dark:focus:border-slate-600"
              />
              <span className="text-xs text-slate-500 dark:text-slate-400">
                created {new Date(c.createdAt).toLocaleDateString()}
              </span>
              <select
                value={c.color}
                onChange={(e) => void recolor(c, e.target.value as TicketCategoryColor)}
                className="rounded border border-slate-300 px-1.5 py-0.5 text-xs dark:border-slate-700 dark:bg-slate-950"
                aria-label={`Color for ${c.name}`}
              >
                {TICKET_CATEGORY_COLORS.map((cc) => (
                  <option key={cc} value={cc}>
                    {cc}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void destroy(c.id, c.name)}
                aria-label={`Delete ${c.name}`}
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
