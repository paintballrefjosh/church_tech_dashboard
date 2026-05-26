"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { NOTE_COLORS, type Note, type NoteColor } from "@church/shared";

const COLOR_CLASS: Record<NoteColor, string> = {
  default: "bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800",
  amber: "bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-900",
  rose: "bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-900",
  emerald: "bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900",
  sky: "bg-sky-50 dark:bg-sky-950/40 border-sky-200 dark:border-sky-900",
  violet: "bg-violet-50 dark:bg-violet-950/40 border-violet-200 dark:border-violet-900",
  slate: "bg-slate-100 dark:bg-slate-800/60 border-slate-300 dark:border-slate-700",
};

const DOT_CLASS: Record<NoteColor, string> = {
  default: "bg-white border-slate-400",
  amber: "bg-amber-300",
  rose: "bg-rose-300",
  emerald: "bg-emerald-300",
  sky: "bg-sky-300",
  violet: "bg-violet-300",
  slate: "bg-slate-400",
};

interface Props {
  initial: Note[];
  initialArchived: boolean;
  initialQuery: string;
}

export function NotesBoard({ initial, initialArchived, initialQuery }: Props) {
  const [notes, setNotes] = useState<Note[]>(initial);
  const [archived, setArchived] = useState(initialArchived);
  const [query, setQuery] = useState(initialQuery);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    const qs = new URLSearchParams();
    if (archived) qs.set("archived", "true");
    if (query.trim()) qs.set("q", query.trim());
    const res = await fetch(`/api/notes${qs.toString() ? `?${qs}` : ""}`, {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!res.ok) {
      setError(`Couldn't load notes (${res.status})`);
      return;
    }
    setNotes((await res.json()) as Note[]);
  }, [archived, query]);

  useEffect(() => {
    refresh();
  }, [archived, refresh]);

  // Also filter locally so an optimistic archive/unarchive removes the card
  // from the current view immediately, before the server refetch lands.
  const sorted = useMemo(
    () =>
      [...notes]
        .filter((n) => n.archived === archived)
        .sort(
          (a, b) =>
            Number(b.pinned) - Number(a.pinned) ||
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        ),
    [notes, archived],
  );

  function update(local: Note) {
    setNotes((prev) => {
      const idx = prev.findIndex((n) => n.id === local.id);
      if (idx === -1) return [local, ...prev];
      const copy = prev.slice();
      copy[idx] = local;
      return copy;
    });
  }
  function removeLocal(id: string) {
    setNotes((prev) => prev.filter((n) => n.id !== id));
  }

  function createBlank() {
    startTransition(async () => {
      setError(null);
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "", body: "" }),
        credentials: "same-origin",
      });
      if (!res.ok) {
        setError(`Couldn't create note (${res.status})`);
        return;
      }
      const note = (await res.json()) as Note;
      update(note);
    });
  }

  function patch(id: string, partial: Partial<Note>) {
    update({ ...(notes.find((n) => n.id === id) as Note), ...partial });
    fetch(`/api/notes/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(partial),
      credentials: "same-origin",
    })
      .then(async (r) => {
        if (r.ok) {
          const fresh = (await r.json()) as Note;
          update(fresh);
        } else {
          setError(`Couldn't save (${r.status})`);
          refresh();
        }
      })
      .catch(() => {
        setError("Network error saving note");
        refresh();
      });
  }

  function destroy(id: string) {
    removeLocal(id);
    fetch(`/api/notes/${id}`, { method: "DELETE", credentials: "same-origin" }).catch(() => refresh());
  }

  return (
    <div>
      <header className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">Notes</h1>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") refresh();
            }}
            placeholder="Search…"
            className="w-48 rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950"
          />
          <button
            type="button"
            onClick={() => setArchived((v) => !v)}
            className={`rounded-md border px-3 py-1.5 text-sm ${
              archived
                ? "border-brand-600 bg-brand-50 text-brand-700 dark:bg-brand-700/20"
                : "border-slate-300 text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
            }`}
            aria-pressed={archived}
          >
            {archived ? "Showing archived" : "Active"}
          </button>
          <button
            type="button"
            onClick={createBlank}
            disabled={pending}
            className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
          >
            {pending ? "Adding…" : "+ Add note"}
          </button>
        </div>
      </header>

      {error ? (
        <p role="alert" className="mb-4 rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300">
          {error}
        </p>
      ) : null}

      {sorted.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
          {archived ? "No archived notes." : "No notes yet. Click \"+ Add note\" to create one."}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {sorted.map((n) => (
            <NoteCard
              key={n.id}
              note={n}
              onPatch={(partial) => patch(n.id, partial)}
              onDelete={() => destroy(n.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function NoteCard({
  note,
  onPatch,
  onDelete,
}: {
  note: Note;
  onPatch: (partial: Partial<Note>) => void;
  onDelete: () => void;
}) {
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);

  // Keep local state in sync if server-side updates land (e.g., realtime push).
  useEffect(() => {
    setTitle(note.title);
    setBody(note.body);
  }, [note.title, note.body]);

  function commit() {
    if (title !== note.title || body !== note.body) onPatch({ title, body });
  }

  return (
    <article
      className={`rounded-lg border p-3 shadow-sm transition hover:shadow ${COLOR_CLASS[note.color as NoteColor] ?? COLOR_CLASS.default}`}
    >
      <div className="flex items-start gap-2">
        <input
          aria-label="Note title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commit}
          placeholder="Title"
          className="flex-1 bg-transparent text-base font-semibold outline-none placeholder:text-slate-400 dark:placeholder:text-slate-500"
        />
        <button
          type="button"
          aria-label={note.pinned ? "Unpin" : "Pin"}
          title={note.pinned ? "Unpin" : "Pin"}
          onClick={() => onPatch({ pinned: !note.pinned })}
          className={`rounded p-1 text-xs ${note.pinned ? "text-amber-600" : "text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"}`}
        >
          {note.pinned ? "Pinned" : "Pin"}
        </button>
      </div>
      <textarea
        aria-label="Note body"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onBlur={commit}
        placeholder="Take a note…"
        rows={4}
        className="mt-2 w-full resize-y bg-transparent text-sm outline-none placeholder:text-slate-400 dark:placeholder:text-slate-500"
      />
      <footer className="mt-2 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
        <div className="flex items-center gap-1.5">
          {NOTE_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Colour: ${c}`}
              onClick={() => onPatch({ color: c })}
              className={`h-4 w-4 rounded-full border ${DOT_CLASS[c]} ${
                note.color === c ? "ring-2 ring-offset-2 ring-slate-500 ring-offset-transparent" : ""
              }`}
            />
          ))}
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => onPatch({ archived: !note.archived })}
            className="hover:text-slate-800 dark:hover:text-slate-200"
          >
            {note.archived ? "Unarchive" : "Archive"}
          </button>
          <button
            type="button"
            onClick={() => {
              if (confirm("Delete this note? This cannot be undone.")) onDelete();
            }}
            className="text-rose-600 hover:text-rose-700"
          >
            Delete
          </button>
        </div>
      </footer>
    </article>
  );
}
