"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Save } from "lucide-react";

export function NewTemplateForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const r = await fetch("/api/checklists/templates", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || null,
        }),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { message?: string };
        setErr(b.message ?? `Create failed (${r.status})`);
        return;
      }
      const tpl = (await r.json()) as { id: string };
      router.push(`/admin/checklists/templates/${tpl.id}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-4 text-sm">
      <label className="block">
        <span className="text-xs text-slate-500">Name</span>
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={200}
          placeholder="Sunday Sound Setup"
          className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-950"
        />
      </label>
      <label className="block">
        <span className="text-xs text-slate-500">Description (optional)</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={2000}
          rows={3}
          placeholder="What this checklist is for, who runs it…"
          className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-950"
        />
      </label>
      <div className="flex items-center gap-3 pt-2">
        <button
          type="submit"
          disabled={busy || !name.trim()}
          className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-2 text-white hover:bg-brand-700 disabled:opacity-50"
        >
          <Save className="h-4 w-4" aria-hidden /> Create template
        </button>
        {err ? <span className="text-rose-600 dark:text-rose-400">{err}</span> : null}
      </div>
    </form>
  );
}
