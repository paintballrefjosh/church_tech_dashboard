"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { Responsive, WidthProvider, type Layout, type Layouts } from "react-grid-layout";
import {
  StickyNote,
  Plus,
  Pin,
  PinOff,
  Archive,
  ArchiveRestore,
  Trash2,
  Paperclip,
  GripVertical,
  GripHorizontal,
} from "lucide-react";
import { NOTE_COLORS, type Note, type NoteColor } from "@church/shared";
import { NoteMedia } from "./note-media";
import { TagPicker } from "@/components/tag-picker";
import { TagFilter } from "@/components/tag-filter";
import { type TagLike } from "@/components/tag-badge";
import {
  type Block,
  type MediaRef,
  buildAttachmentMarkdown,
  parseBlocks,
  setMediaWidth,
  stringifyBlocks,
} from "./note-body-parser";

import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

const ResponsiveGridLayout = WidthProvider(Responsive);
// Breakpoints map to Tailwind's defaults so the rest of the UI agrees.
// `lg` is the canonical layout we persist; the smaller layouts are derived
// by RGL from `lg` whenever the viewport drops below the breakpoint.
const BREAKPOINTS = { lg: 1024, md: 768, sm: 640, xs: 0 };
const COLS_PER_BP = { lg: 12, md: 8, sm: 4, xs: 1 };
const COLS = 12;
const ROW_HEIGHT = 40;
const DEFAULT_W = 4;
const DEFAULT_H = 6;
const MIN_W = 2;
const MIN_H = 3;

// Custom dataTransfer type used for media-block drags inside a single note.
// Distinguishes "reorder within card" from a "Files" drop (upload).
const MEDIA_BLOCK_MIME = "application/x-note-block-idx";

/**
 * Cross-browser caret-from-point. Webkit/Blink uses caretRangeFromPoint;
 * Firefox uses caretPositionFromPoint. Returns null if the point is over
 * nothing focusable (e.g. outside the document).
 */
function caretFromPoint(
  x: number,
  y: number,
): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (
      x: number,
      y: number,
    ) => { offsetNode: Node; offset: number } | null;
  };
  if (typeof doc.caretRangeFromPoint === "function") {
    const r = doc.caretRangeFromPoint(x, y);
    if (r) return { node: r.startContainer, offset: r.startOffset };
  }
  if (typeof doc.caretPositionFromPoint === "function") {
    const p = doc.caretPositionFromPoint(x, y);
    if (p) return { node: p.offsetNode, offset: p.offset };
  }
  return null;
}

/**
 * Character offset from the start of `container` to the (node, offset)
 * position. Uses a Range to measure — handles multi-text-node DOMs that
 * React might produce, not just the single-text-node case.
 */
function measureCharOffset(container: Node, node: Node, offset: number): number {
  if (!container.contains(node)) return -1;
  const range = document.createRange();
  range.setStart(container, 0);
  try {
    range.setEnd(node, offset);
  } catch {
    return -1;
  }
  return range.toString().length;
}

const COLOR_CLASS: Record<NoteColor, string> = {
  default: "bg-white dark:bg-slate-900 border-slate-300 dark:border-slate-800",
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
  // `query` updates on every keystroke for a responsive input, but we only hit
  // the server off `debouncedQuery` so typing doesn't fire a fetch per key.
  const [debouncedQuery, setDebouncedQuery] = useState(initialQuery);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Track which RGL breakpoint we're currently rendering at. We only persist
  // layout changes when the user is on `lg` — smaller breakpoints render an
  // auto-derived layout that's not meant to mutate the canonical positions.
  const [currentBp, setCurrentBp] = useState<keyof typeof COLS_PER_BP>("lg");
  const [tagFilter, setTagFilter] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    const qs = new URLSearchParams();
    if (archived) qs.set("archived", "true");
    if (debouncedQuery.trim()) qs.set("q", debouncedQuery.trim());
    if (tagFilter) qs.set("tagId", tagFilter);
    const res = await fetch(`/api/notes${qs.toString() ? `?${qs}` : ""}`, {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!res.ok) {
      setError(`Couldn't load notes (${res.status})`);
      return;
    }
    setNotes((await res.json()) as Note[]);
  }, [archived, debouncedQuery, tagFilter]);

  // Coalesce keystrokes: only push `query` into `debouncedQuery` after a pause.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 350);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    refresh();
  }, [archived, tagFilter, refresh]);

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

  /**
   * Build a react-grid-layout layout array from the current notes.
   *
   *  - Pinned notes are forced to y=0. With compactType="vertical" they pack
   *    at the top in pin/auto-flow order. Their stored y is preserved in the
   *    DB so unpinning restores the original position.
   *  - Unpinned notes with a saved grid placement (all four columns set) keep
   *    their slot.
   *  - Unpinned, never-placed notes auto-flow into the next free row below
   *    the pinned block.
   */
  const layout: Layout[] = useMemo(() => {
    const out: Layout[] = [];
    // Pinned cards always render at y=0 so they pack at the top under vertical
    // compaction. We auto-assign x across the first row (wrapping if needed)
    // so pinning many notes doesn't overlap them.
    let pinX = 0;
    let pinRowY = 0;
    let cursorX = 0;
    // The auto-flow cursor for unpinned starts a row below the last pinned
    // row so brand-new notes land below pinned ones, not on top of them.
    let cursorY = 0;
    const pinned = sorted.filter((n) => n.pinned);
    const unpinned = sorted.filter((n) => !n.pinned);

    for (const n of pinned) {
      const w = n.gridW ?? DEFAULT_W;
      if (pinX + w > COLS) {
        pinX = 0;
        pinRowY += n.gridH ?? DEFAULT_H;
      }
      out.push({
        i: n.id,
        x: pinX,
        y: pinRowY,
        w,
        h: n.gridH ?? DEFAULT_H,
        minW: MIN_W,
        minH: MIN_H,
      });
      pinX += w;
    }
    cursorY = pinRowY + (pinned.length ? DEFAULT_H : 0);

    for (const n of unpinned) {
      if (
        n.gridX !== null &&
        n.gridY !== null &&
        n.gridW !== null &&
        n.gridH !== null
      ) {
        out.push({
          i: n.id,
          x: n.gridX,
          y: Math.max(n.gridY, cursorY),
          w: n.gridW,
          h: n.gridH,
          minW: MIN_W,
          minH: MIN_H,
        });
      } else {
        if (cursorX + DEFAULT_W > COLS) {
          cursorX = 0;
          cursorY += DEFAULT_H;
        }
        out.push({
          i: n.id,
          x: cursorX,
          y: cursorY,
          w: DEFAULT_W,
          h: DEFAULT_H,
          minW: MIN_W,
          minH: MIN_H,
        });
        cursorX += DEFAULT_W;
      }
    }
    return out;
  }, [sorted]);

  // Persist position changes. Debounced per-note so dragging a card across the
  // grid doesn't fire dozens of PATCH requests; only the final resting place
  // hits the server.
  const saveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  useEffect(() => () => {
    for (const t of saveTimers.current.values()) clearTimeout(t);
  }, []);
  function onLayoutChange(next: Layout[]) {
    // Only persist when the user is on the canonical `lg` breakpoint.
    // Smaller breakpoints render a derived layout; saving those positions
    // would corrupt the desktop layout the user actually configured.
    if (currentBp !== "lg") return;
    for (const l of next) {
      const note = notes.find((n) => n.id === l.i);
      if (!note) continue;
      // For pinned notes we ignore the y RGL is reporting (always forced to
      // 0 in our layout above). The stored gridY stays at whatever the note
      // had before pinning so unpinning restores the original spot. Without
      // this guard a drag-y on a pinned card would persist a phantom y that
      // wouldn't render visually.
      const targetY = note.pinned ? note.gridY ?? 0 : l.y;
      if (
        note.gridX === l.x &&
        note.gridY === targetY &&
        note.gridW === l.w &&
        note.gridH === l.h
      ) {
        continue;
      }
      // Optimistic local update so the next render is consistent with what
      // we just saw from RGL.
      update({ ...note, gridX: l.x, gridY: targetY, gridW: l.w, gridH: l.h });
      const id = l.i;
      const existing = saveTimers.current.get(id);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        saveTimers.current.delete(id);
        fetch(`/api/notes/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ gridX: l.x, gridY: targetY, gridW: l.w, gridH: l.h }),
          credentials: "same-origin",
        }).catch(() => {
          setError("Couldn't save layout");
          refresh();
        });
      }, 500);
      saveTimers.current.set(id, timer);
    }
  }

  return (
    <div>
      <header className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="flex items-center gap-2.5 text-2xl font-semibold">
          <StickyNote className="h-6 w-6 text-brand-600" aria-hidden />
          Notes
        </h1>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Enter flushes the debounce so the search fires immediately.
              if (e.key === "Enter") setDebouncedQuery(query);
            }}
            placeholder="Search…"
            className="w-48 rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950"
          />
          <button
            type="button"
            onClick={() => setArchived((v) => !v)}
            className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm ${
              archived
                ? "border-brand-600 bg-brand-50 text-brand-700 dark:bg-brand-700/20"
                : "border-slate-300 text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
            }`}
            aria-pressed={archived}
          >
            {archived ? (
              <>
                <ArchiveRestore className="h-4 w-4" aria-hidden /> Showing archived
              </>
            ) : (
              <>
                <Archive className="h-4 w-4" aria-hidden /> Active
              </>
            )}
          </button>
          <button
            type="button"
            onClick={createBlank}
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
          >
            <Plus className="h-4 w-4" aria-hidden /> {pending ? "Adding…" : "Add note"}
          </button>
        </div>
      </header>

      <TagFilter selectedId={tagFilter} onChange={setTagFilter} />

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
        <ResponsiveGridLayout
          className="notes-grid"
          // We feed only the `lg` layout. RGL auto-derives layouts for md/sm/xs
          // from it when the viewport crosses a breakpoint — those are
          // ephemeral so we don't have to maintain four sets of coordinates.
          layouts={{ lg: layout } as Layouts}
          breakpoints={BREAKPOINTS}
          cols={COLS_PER_BP}
          rowHeight={ROW_HEIGHT}
          isDraggable
          isResizable
          draggableHandle=".note-drag-handle"
          margin={[12, 12]}
          containerPadding={[0, 0]}
          onLayoutChange={(currentLayout) => onLayoutChange(currentLayout)}
          onBreakpointChange={(bp) => setCurrentBp(bp as keyof typeof COLS_PER_BP)}
          // RGL pushes other cards around when dragging — feels right for a
          // sticky-note board where the user expects neighbours to make room.
          compactType="vertical"
        >
          {sorted.map((n) => (
            <div key={n.id}>
              <NoteCard
                note={n}
                onPatch={(partial) => patch(n.id, partial)}
                onDelete={() => destroy(n.id)}
              />
            </div>
          ))}
        </ResponsiveGridLayout>
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
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [tags, setTags] = useState<TagLike[]>([]);
  const wrapRef = useRef<HTMLElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [containerWidth, setContainerWidth] = useState(320);

  // Tags are fetched per-card so the list endpoint can stay schema-stable.
  // Cheap on the wire — one row per assignment — and lets the picker write
  // back to /api/tags/note/<id> without round-tripping the whole note.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await fetch(`/api/tags/for/note/${note.id}`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!r.ok || cancelled) return;
      setTags((await r.json()) as TagLike[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [note.id]);

  async function saveTags(next: TagLike[]) {
    setTags(next);
    await fetch(`/api/tags/for/note/${note.id}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tagIds: next.map((t) => t.id) }),
    });
  }
  // Last text-block focus position. uploadFile splits the focused text block
  // at `pos` and inserts new media there; the file-drop handler and the
  // Attach button both consult this.
  const [focused, setFocused] = useState<{ blockIdx: number; pos: number } | null>(null);
  // The block index of the media item currently being dragged for reorder.
  // Tracked so DropGap can hide its highlight for the source-adjacent gaps
  // (dropping into your own gap is a no-op).
  const [mediaDragIdx, setMediaDragIdx] = useState<number | null>(null);

  useEffect(() => {
    setTitle(note.title);
    setBody(note.body);
  }, [note.title, note.body]);

  // Track the card's inner width so the media handle clamps properly.
  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setContainerWidth(entry.contentRect.width);
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  function commit(nextBody?: string) {
    const b = nextBody ?? body;
    if (title !== note.title || b !== note.body) onPatch({ title, body: b });
  }

  // The body is the source of truth. Blocks are derived for rendering and
  // for every mutation: we re-parse, mutate the block list, then stringify
  // back to `body`. This keeps the storage format (a single markdown string)
  // identical and lets us round-trip through edits without lossy state.
  const blocks = useMemo(() => parseBlocks(body), [body]);

  function commitBlocks(next: Block[]) {
    const s = stringifyBlocks(next);
    setBody(s);
    commit(s);
  }

  function updateTextBlock(idx: number, value: string) {
    const next = blocks.slice();
    next[idx] = { type: "text", value };
    // Don't commit on every keystroke — onBlur of the textarea triggers
    // commit() with the latest body. Just update local state here.
    setBody(stringifyBlocks(next));
  }

  function insertMediaAtCursor(snippet: string) {
    // Build a fresh MediaRef for the new snippet so the inserted block
    // matches the shape of all the others. We don't actually use the index
    // field after insertion — parseBlocks recomputes it next render.
    const ref: MediaRef = {
      index: 0,
      match: snippet,
      alt: snippet.match(/^!\[([^\]]*)\]/)?.[1] ?? "",
      url: snippet.match(/\(([^)\s]+)\)/)?.[1] ?? "",
      kind: /[?&]t=video/.test(snippet) ? "video" : "image",
      width: null,
    };
    const next = blocks.slice();
    const target = focused?.blockIdx;
    if (typeof target === "number" && blocks[target]?.type === "text") {
      // Split the focused text block at the cursor and drop the media in
      // between, with empty text-block anchors on both sides so the user
      // can land a cursor adjacent to the new media on either side.
      const v = (blocks[target] as { type: "text"; value: string }).value;
      const pos = Math.min(focused?.pos ?? v.length, v.length);
      const before = v.slice(0, pos);
      const after = v.slice(pos);
      next.splice(target, 1,
        { type: "text", value: before },
        { type: "media", ref },
        { type: "text", value: after },
      );
    } else {
      // No focused text block — append the media at the end with a trailing
      // empty text anchor so the user can keep typing after it.
      next.push({ type: "media", ref }, { type: "text", value: "" });
    }
    commitBlocks(next);
  }

  async function uploadFile(file: File) {
    setUploadError(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch(`/api/notes/${note.id}/attachments`, {
        method: "POST",
        body: fd,
        credentials: "same-origin",
      });
      if (!r.ok) {
        const errBody = (await r.json().catch(() => ({}))) as { message?: string };
        setUploadError(errBody.message ?? `Upload failed (${r.status})`);
        return;
      }
      const att = (await r.json()) as {
        id: string;
        filename: string;
        contentType: string;
      };
      const snippet = buildAttachmentMarkdown({
        noteId: note.id,
        attachmentId: att.id,
        filename: att.filename,
        contentType: att.contentType,
      });
      insertMediaAtCursor(snippet);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function onDrop(e: React.DragEvent) {
    // Files: upload at cursor. Note-internal media-block drags are handled
    // by the DropGap components themselves; this handler only runs if no
    // gap caught the drop (e.g. drop landed on a text block).
    const f = e.dataTransfer.files?.[0];
    if (!f) return;
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    void uploadFile(f);
  }
  function onDragOver(e: React.DragEvent) {
    if (e.dataTransfer.types?.includes("Files")) {
      e.preventDefault();
      e.stopPropagation();
      if (!dragOver) setDragOver(true);
    }
  }
  function onDragLeave(e: React.DragEvent) {
    // Only fire when leaving the card boundary, not when crossing children.
    if (e.currentTarget === e.target) setDragOver(false);
  }

  function onMediaResize(blockIdx: number, newWidth: number) {
    const target = blocks[blockIdx];
    if (!target || target.type !== "media") return;
    const nextBody = setMediaWidth(body, target.ref, newWidth);
    setBody(nextBody);
    commit(nextBody);
  }

  function onMediaRemove(blockIdx: number) {
    const target = blocks[blockIdx];
    if (!target || target.type !== "media") return;
    if (!confirm("Remove this attachment?")) return;
    // Pull the attachment id out of the URL so we can DELETE it too. The URL
    // shape is /api/notes/<noteId>/attachments/<aid>?... — anything else we
    // just strip the markdown without a server call.
    const m = target.ref.url.match(/\/api\/notes\/[^/]+\/attachments\/([^/?#]+)/);
    if (m) {
      void fetch(`/api/notes/${note.id}/attachments/${m[1]}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
    }
    // Drop the media block AND collapse the two text anchors that surrounded
    // it into one — otherwise consecutive empty text blocks pile up over a
    // few edit/remove cycles.
    const next = blocks.slice();
    next.splice(blockIdx, 1);
    if (
      blockIdx > 0 &&
      blockIdx <= next.length &&
      next[blockIdx - 1]?.type === "text" &&
      next[blockIdx]?.type === "text"
    ) {
      const left = (next[blockIdx - 1] as { type: "text"; value: string }).value;
      const right = (next[blockIdx] as { type: "text"; value: string }).value;
      const joined = left + (left && right ? "\n\n" : "") + right;
      next.splice(blockIdx - 1, 2, { type: "text", value: joined });
    }
    commitBlocks(next);
  }

  function moveMediaBlock(sourceBlockIdx: number, targetGapIdx: number) {
    const src = blocks[sourceBlockIdx];
    if (!src || src.type !== "media") return;
    // Splice the source out, then insert at the target gap. The target gap
    // index is relative to the ORIGINAL blocks array (gap N sits BEFORE
    // block N), so we have to account for the removal shifting indices.
    const next = blocks.slice();
    next.splice(sourceBlockIdx, 1);
    const insertAt = targetGapIdx > sourceBlockIdx ? targetGapIdx - 1 : targetGapIdx;
    // Make sure there are text anchors on both sides of the moved media.
    const before = next[insertAt - 1];
    const after = next[insertAt];
    const toInsert: Block[] = [];
    if (!before || before.type !== "text") toInsert.push({ type: "text", value: "" });
    toInsert.push(src);
    if (!after || after.type !== "text") toInsert.push({ type: "text", value: "" });
    next.splice(insertAt, 0, ...toInsert);
    commitBlocks(next);
  }

  /**
   * Drop the source media block at character `textOffset` inside the text
   * block at `targetTextIdx`. The browser places the native textarea drop
   * caret as the user drags, so `textOffset` is the offset the user can SEE
   * before releasing. We split the target text into before/after, drop the
   * media between them, and collapse the anchor pair that's left where the
   * source used to be.
   */
  function moveMediaIntoText(
    sourceBlockIdx: number,
    targetTextIdx: number,
    textOffset: number,
  ) {
    const src = blocks[sourceBlockIdx];
    if (!src || src.type !== "media") return;
    const target = blocks[targetTextIdx];
    if (!target || target.type !== "text") return;

    const next = blocks.slice();
    next.splice(sourceBlockIdx, 1);
    let adjTargetIdx = targetTextIdx > sourceBlockIdx ? targetTextIdx - 1 : targetTextIdx;

    // After src removal, the two anchors that bracketed it become adjacent
    // text blocks. Merge them so we don't accumulate empty anchors over
    // repeated drag-drop cycles.
    const mergeIdx = sourceBlockIdx - 1;
    if (
      mergeIdx >= 0 &&
      next[mergeIdx]?.type === "text" &&
      next[mergeIdx + 1]?.type === "text"
    ) {
      const left = (next[mergeIdx] as { type: "text"; value: string }).value;
      const right = (next[mergeIdx + 1] as { type: "text"; value: string }).value;
      const joined = left + (left && right ? "\n\n" : "") + right;
      next.splice(mergeIdx, 2, { type: "text", value: joined });
      // If our target was the right half of the merge, its index drops by
      // one AND its offset shifts by left.length (+ the optional joiner).
      if (adjTargetIdx === mergeIdx + 1) {
        const shift = left.length + (left && right ? 2 : 0);
        textOffset = textOffset + shift;
        adjTargetIdx = mergeIdx;
      } else if (adjTargetIdx > mergeIdx + 1) {
        adjTargetIdx -= 1;
      }
    }

    const t = next[adjTargetIdx];
    if (!t || t.type !== "text") return;
    const v = t.value;
    const pos = Math.min(Math.max(textOffset, 0), v.length);
    const before = v.slice(0, pos);
    const after = v.slice(pos);
    next.splice(
      adjTargetIdx,
      1,
      { type: "text", value: before },
      { type: "media", ref: src.ref },
      { type: "text", value: after },
    );
    commitBlocks(next);
  }

  return (
    <article
      ref={wrapRef}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      className={`group relative flex h-full flex-col overflow-hidden rounded-lg border p-3 shadow-sm transition hover:shadow ${
        COLOR_CLASS[note.color as NoteColor] ?? COLOR_CLASS.default
      } ${dragOver ? "ring-2 ring-brand-500" : ""}`}
    >
      {dragOver ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-brand-500/10 text-sm font-medium text-brand-700 dark:text-brand-200">
          Drop to attach
        </div>
      ) : null}

      {/* Drag handle — react-grid-layout's draggableHandle selector matches
          this. Hover-only visibility keeps the card looking clean. */}
      <div
        // h-4 on devices that can hover; h-6 on touch (no hover) so the
        // handle is finger-sized. Opacity is always 100 on touch since there's
        // no hover-reveal affordance.
        className="note-drag-handle absolute left-1/2 top-0 z-10 flex h-4 -translate-x-1/2 cursor-move items-center justify-center rounded-b bg-slate-500/20 px-3 text-slate-400 opacity-40 transition hover:bg-slate-500/30 hover:text-slate-700 hover:opacity-100 group-hover:opacity-100 dark:text-slate-500 dark:hover:text-slate-200 [@media(hover:none)]:h-6 [@media(hover:none)]:px-5 [@media(hover:none)]:opacity-100"
        title="Drag to rearrange"
        aria-label="Drag to rearrange"
      >
        <GripVertical className="h-3 w-3 rotate-90" aria-hidden />
      </div>

      <div className="flex items-start gap-2">
        <input
          aria-label="Note title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => commit()}
          placeholder="Title"
          className="flex-1 bg-transparent text-base font-semibold outline-none placeholder:text-slate-400 dark:placeholder:text-slate-500"
        />
        <button
          type="button"
          aria-label={note.pinned ? "Unpin" : "Pin"}
          title={note.pinned ? "Unpin" : "Pin"}
          onClick={() => onPatch({ pinned: !note.pinned })}
          className={`rounded p-1 ${
            note.pinned ? "text-amber-600" : "text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
          }`}
        >
          {note.pinned ? <Pin className="h-4 w-4 fill-current" aria-hidden /> : <PinOff className="h-4 w-4" aria-hidden />}
        </button>
      </div>

      <div className="mt-2 flex min-h-0 flex-1 flex-col overflow-auto">
        {blocks.map((block, idx) => {
          const isOnlyText = blocks.length === 1 && block.type === "text";
          // Key: stable per-media URL for media so React doesn't remount on
          // every keystroke in a neighbour; index for text blocks (their
          // content is what we're editing and the slot identifies it).
          return (
            <Fragment key={block.type === "media" ? `m:${block.ref.match}` : `t:${idx}`}>
              {block.type === "text" ? (
                <TextBlock
                  value={block.value}
                  stretch={isOnlyText}
                  placeholder={
                    idx === 0
                      ? "Take a note… (drop files here to attach)"
                      : undefined
                  }
                  isDragActive={mediaDragIdx !== null}
                  dropMime={MEDIA_BLOCK_MIME}
                  onChange={(v) => updateTextBlock(idx, v)}
                  onCommit={() => commit()}
                  onCursor={(pos) => setFocused({ blockIdx: idx, pos })}
                  onMediaDrop={(srcIdx, pos) => moveMediaIntoText(srcIdx, idx, pos)}
                />
              ) : (
                <MediaBlock
                  blockIdx={idx}
                  ref={block.ref}
                  containerWidth={containerWidth - 24}
                  mime={MEDIA_BLOCK_MIME}
                  acceptDrop={mediaDragIdx !== null && mediaDragIdx !== idx}
                  onDragStart={() => setMediaDragIdx(idx)}
                  onDragEnd={() => setMediaDragIdx(null)}
                  onResize={(w) => onMediaResize(idx, w)}
                  onRemove={() => onMediaRemove(idx)}
                  onMediaDropBefore={(srcIdx) => moveMediaBlock(srcIdx, idx)}
                  onMediaDropAfter={(srcIdx) => moveMediaBlock(srcIdx, idx + 1)}
                />
              )}
            </Fragment>
          );
        })}
      </div>

      {uploadError ? (
        <p role="alert" className="mt-1 text-xs text-rose-600">
          {uploadError}
        </p>
      ) : null}

      <div className="mt-2">
        <TagPicker value={tags} onChange={(next) => void saveTags(next)} />
      </div>

      <footer className="mt-2 flex items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
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
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            disabled={uploading}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void uploadFile(f);
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="inline-flex items-center gap-1 hover:text-slate-800 dark:hover:text-slate-200 disabled:opacity-50"
            title="Attach file"
          >
            <Paperclip className="h-3.5 w-3.5" aria-hidden />
            {uploading ? "Uploading…" : "Attach"}
          </button>
          <button
            type="button"
            onClick={() => onPatch({ archived: !note.archived })}
            className="inline-flex items-center gap-1 hover:text-slate-800 dark:hover:text-slate-200"
          >
            {note.archived ? (
              <>
                <ArchiveRestore className="h-3.5 w-3.5" aria-hidden /> Unarchive
              </>
            ) : (
              <>
                <Archive className="h-3.5 w-3.5" aria-hidden /> Archive
              </>
            )}
          </button>
          <button
            type="button"
            onClick={() => {
              if (confirm("Delete this note? This cannot be undone.")) onDelete();
            }}
            className="inline-flex items-center gap-1 text-rose-600 hover:text-rose-700"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete
          </button>
        </div>
      </footer>
    </article>
  );
}

/**
 * One text run inside a note. Auto-grows to its content height so the
 * surrounding flex column can keep packing additional blocks below it. If
 * the block is the ONLY block in the note (no media), it stretches to fill
 * the available card height so the user can click anywhere to focus.
 */
function TextBlock({
  value,
  stretch,
  placeholder,
  isDragActive,
  dropMime,
  onChange,
  onCommit,
  onCursor,
  onMediaDrop,
}: {
  value: string;
  stretch: boolean;
  placeholder?: string;
  isDragActive: boolean;
  dropMime: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCursor: (pos: number) => void;
  onMediaDrop: (srcBlockIdx: number, textOffset: number) => void;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  // Auto-grow: snap height to scrollHeight whenever the value changes.
  // Skip when `stretch` is on — flex-1 already controls the height.
  useLayoutEffect(() => {
    if (isDragActive || stretch || !taRef.current) return;
    const el = taRef.current;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value, stretch, isDragActive]);

  function report() {
    if (taRef.current) onCursor(taRef.current.selectionStart);
  }

  // During a media drag we swap the textarea out for a div overlay. The div
  // gives us caretRangeFromPoint (textareas don't), so we can paint our own
  // caret bar at the exact character offset under the cursor.
  if (isDragActive) {
    return (
      <DropTextOverlay
        value={value}
        stretch={stretch}
        placeholder={placeholder}
        dropMime={dropMime}
        onMediaDrop={onMediaDrop}
      />
    );
  }

  return (
    <textarea
      ref={taRef}
      aria-label="Note body"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onFocus={report}
      onSelect={report}
      onKeyUp={report}
      onClick={report}
      placeholder={placeholder}
      rows={stretch ? 3 : 1}
      className={
        "w-full resize-none bg-transparent text-sm outline-none placeholder:text-slate-400 dark:placeholder:text-slate-500 " +
        (stretch ? "min-h-0 flex-1" : "")
      }
    />
  );
}

/**
 * Drop-time replacement for a text block. Renders the same text in a plain
 * <div> so caretRangeFromPoint works (it doesn't on textareas). On every
 * dragover we compute the character offset under the cursor and render a
 * thin vertical bar at exactly that position. On drop we hand the offset
 * back to the card to splice the media in.
 */
function DropTextOverlay({
  value,
  stretch,
  placeholder,
  dropMime,
  onMediaDrop,
}: {
  value: string;
  stretch: boolean;
  placeholder?: string;
  dropMime: string;
  onMediaDrop: (srcBlockIdx: number, textOffset: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const lastOffset = useRef<number>(0);
  const [caret, setCaret] = useState<{ x: number; y: number; h: number } | null>(null);

  function updateCaret(clientX: number, clientY: number) {
    const container = ref.current;
    if (!container) return;
    const parent = container.getBoundingClientRect();
    const lineH = parseFloat(getComputedStyle(container).lineHeight) || 20;

    function setEndOfText() {
      lastOffset.current = value.length;
      // Position the caret at the end of the rendered text so the user
      // sees where their drop will land (the very tail), not at the
      // container origin.
      const r = document.createRange();
      r.selectNodeContents(container!);
      r.collapse(false);
      const rect = r.getBoundingClientRect();
      if (rect.width || rect.height) {
        setCaret({
          x: rect.left - parent.left,
          y: rect.top - parent.top,
          h: rect.height || lineH,
        });
      } else {
        setCaret({ x: 0, y: 0, h: parent.height || lineH });
      }
    }

    const hit = caretFromPoint(clientX, clientY);
    if (!hit || !container.contains(hit.node)) {
      // Cursor is over the placeholder or beyond the last char — snap to end.
      setEndOfText();
      return;
    }
    const offset = measureCharOffset(container, hit.node, hit.offset);
    if (offset < 0) {
      setEndOfText();
      return;
    }
    lastOffset.current = offset;
    const range = document.createRange();
    range.setStart(hit.node, hit.offset);
    range.collapse(true);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      // End-of-line rects collapse to zero in some browsers; fall back to
      // end-of-text for the visual indicator only.
      setEndOfText();
      return;
    }
    setCaret({
      x: rect.left - parent.left,
      y: rect.top - parent.top,
      h: rect.height || lineH,
    });
  }

  return (
    <div
      ref={ref}
      role="textbox"
      aria-label="Note body (drop target)"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(dropMime)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        updateCaret(e.clientX, e.clientY);
      }}
      onDragLeave={(e) => {
        if (!ref.current?.contains(e.relatedTarget as Node | null)) {
          setCaret(null);
        }
      }}
      onDrop={(e) => {
        const raw = e.dataTransfer.getData(dropMime);
        if (!raw) return;
        e.preventDefault();
        e.stopPropagation();
        setCaret(null);
        const srcIdx = parseInt(raw, 10);
        if (Number.isFinite(srcIdx)) onMediaDrop(srcIdx, lastOffset.current);
      }}
      className={
        "relative w-full whitespace-pre-wrap break-words text-sm text-slate-700 dark:text-slate-200 " +
        (stretch ? "min-h-0 flex-1" : "min-h-[1.25rem]")
      }
    >
      {value.length > 0 ? (
        value
      ) : (
        <span className="text-slate-400 dark:text-slate-500">
          {placeholder ?? " "}
        </span>
      )}
      {caret ? (
        <span
          aria-hidden
          className="pointer-events-none absolute w-0.5 animate-pulse bg-brand-500"
          style={{ left: caret.x, top: caret.y, height: caret.h }}
        />
      ) : null}
    </div>
  );
}

/**
 * One media token inside a note. Wraps NoteMedia with a grip-handle button
 * that owns the HTML5 drag gesture for reorder — the rest of the figure
 * stays click-to-resize / click-to-remove with no accidental drag triggers.
 */
function MediaBlock({
  blockIdx,
  ref: mediaRef,
  containerWidth,
  mime,
  acceptDrop,
  onDragStart,
  onDragEnd,
  onResize,
  onRemove,
  onMediaDropBefore,
  onMediaDropAfter,
}: {
  blockIdx: number;
  ref: MediaRef;
  containerWidth: number;
  mime: string;
  acceptDrop: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onResize: (w: number) => void;
  onRemove: () => void;
  onMediaDropBefore: (srcBlockIdx: number) => void;
  onMediaDropAfter: (srcBlockIdx: number) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  // Which half of the block the dragging media is currently hovering over —
  // drives the blue indicator bar at top or bottom.
  const [dropSide, setDropSide] = useState<"before" | "after" | null>(null);

  return (
    <div
      ref={wrapRef}
      className="group/media relative shrink-0"
      onDragOver={(e) => {
        if (!acceptDrop || !e.dataTransfer.types.includes(mime)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        if (!wrapRef.current) return;
        const rect = wrapRef.current.getBoundingClientRect();
        const above = e.clientY < rect.top + rect.height / 2;
        const next = above ? "before" : "after";
        if (next !== dropSide) setDropSide(next);
      }}
      onDragLeave={(e) => {
        // Only clear when we leave the block entirely, not when crossing into
        // a child (e.g. the grip button).
        if (!wrapRef.current?.contains(e.relatedTarget as Node | null)) {
          setDropSide(null);
        }
      }}
      onDrop={(e) => {
        const raw = e.dataTransfer.getData(mime);
        if (!raw) return;
        e.preventDefault();
        e.stopPropagation();
        const srcIdx = parseInt(raw, 10);
        const side = dropSide;
        setDropSide(null);
        if (!Number.isFinite(srcIdx)) return;
        if (side === "before") onMediaDropBefore(srcIdx);
        else onMediaDropAfter(srcIdx);
      }}
    >
      {dropSide === "before" ? (
        <div className="pointer-events-none absolute left-0 right-0 top-0 z-20 h-0.5 rounded bg-brand-500" />
      ) : null}
      <NoteMedia
        url={mediaRef.url}
        kind={mediaRef.kind}
        alt={mediaRef.alt}
        width={mediaRef.width}
        onResizeEnd={onResize}
        onRemove={onRemove}
        containerWidth={containerWidth}
      />
      {dropSide === "after" ? (
        <div className="pointer-events-none absolute bottom-0 left-0 right-0 z-20 h-0.5 rounded bg-brand-500" />
      ) : null}
      {/* Grip handle — top-centre. The only element of the media block that
          is HTML5-draggable, so accidental drags off the image/resize handle
          can't happen. We use a <div> rather than <button> because
          buttons-with-draggable behave inconsistently across browsers (in
          Chrome the click action sometimes wins). Custom drag image is the
          whole wrapper so the ghost looks like the media. */}
      <div
        role="button"
        tabIndex={0}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(mime, String(blockIdx));
          // Some browsers won't initiate a drag with only a custom mime in
          // the payload. A non-empty text/plain placeholder makes the drag
          // reliably start in Chrome and Safari.
          e.dataTransfer.setData("text/plain", " ");
          e.dataTransfer.effectAllowed = "move";
          if (wrapRef.current) {
            const r = wrapRef.current.getBoundingClientRect();
            e.dataTransfer.setDragImage(wrapRef.current, r.width / 2, 16);
          }
          onDragStart();
        }}
        onDragEnd={() => {
          setDropSide(null);
          onDragEnd();
        }}
        aria-label="Drag to reorder attachment"
        title="Drag to reorder"
        className="absolute left-1/2 top-2 z-10 inline-flex h-6 w-8 -translate-x-1/2 cursor-grab select-none items-center justify-center rounded bg-slate-900/60 text-white opacity-0 transition group-hover/media:opacity-100 hover:bg-slate-900 focus:opacity-100 active:cursor-grabbing"
      >
        <GripHorizontal className="h-3.5 w-3.5" aria-hidden />
      </div>
    </div>
  );
}
