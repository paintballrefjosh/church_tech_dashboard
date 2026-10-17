"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import LinkExt from "@tiptap/extension-link";
import { WikiPagePicker, type PickedWikiPage } from "./wiki-page-picker";
import ImageExt from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import TableExt from "@tiptap/extension-table";
import { TextSelection } from "@tiptap/pm/state";
import {
  DEFAULT_TABLE_PAD,
  MAX_TABLE_PAD,
  applyTableMetaToDom,
  cellBackgroundCss,
  formatBgAttr,
  parseBgAttr,
  parsePad,
  serializeTable,
  tablePadCss,
} from "@/lib/wiki-table-markdown";
import TableRowExt from "@tiptap/extension-table-row";
import TableHeaderExt from "@tiptap/extension-table-header";
import TableCellExt from "@tiptap/extension-table-cell";
import { Markdown } from "tiptap-markdown";
import {
  Bold,
  Italic,
  Strikethrough,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Quote,
  Code,
  Code2,
  Link as LinkIcon,
  FileText,
  ImagePlus,
  Minus,
  Table as TableIcon,
  Columns3,
  PaintBucket,
  PanelTop,
  Eye,
  Pencil,
  Undo2,
  Redo2,
  ArrowUpToLine,
  ArrowDownToLine,
  ArrowLeftToLine,
  ArrowRightToLine,
  Trash2,
} from "lucide-react";

/**
 * Confluence-style WYSIWYG editor used by the new-wiki and edit-wiki forms.
 *
 * Source of truth is still plain markdown on disk; this component just hides
 * the syntax. Internally we run TipTap (ProseMirror) with the tiptap-markdown
 * extension so:
 *   - props.value is markdown, parsed into the editor's document on mount;
 *   - on every edit we serialise back to markdown and call onChange;
 *   - images, videos, audio and links round-trip through markdown without
 *     losing their `?t=video|audio` URL markers (we keep the bare URL string
 *     on the image node's src attribute).
 *
 * Inline media: an `<img>` whose src URL carries `?t=video` is rendered as
 * a <video> in the editor (and the same logic runs at view-time in the
 * shared <Markdown> component). Same trick for audio. The body still
 * serialises as `![alt](url?t=video)` — a standard markdown image.
 *
 * Drop-at-cursor: TipTap's handleDrop receives the native drop event and
 * resolves a ProseMirror position from posAtCoords. Combined with the
 * built-in drop-cursor extension (shipped in starter-kit), the user sees
 * the blue caret bar exactly where the file will land.
 */

export type WikiBodyEditorMode = "edit" | "preview" | "source";

export interface WikiBodyEditorHandle {
  /** Focus the editor body. */
  focus(): void;
  /** Insert markdown at the current caret. Used by AttachmentList's "+"
   *  button to splice a snippet that the host already built. */
  insertAtCaret(text: string): void;
}

export const WikiBodyEditor = forwardRef<
  WikiBodyEditorHandle,
  {
    value: string;
    onChange: (next: string) => void;
    placeholder?: string;
    /** Called for paste / drop / toolbar uploads. Should return the
     *  markdown snippet to splice (e.g. `![alt](url)`), or null on failure. */
    onUpload?: (file: File) => Promise<string | null>;
    /** Hidden <input name=...> mirror, included for forms that read FormData.
     *  Both wiki forms now read the body from React state, but keeping this
     *  prop preserves the previous interface. */
    name?: string;
    onSubmitShortcut?: () => void;
    /** Accessible name for the editing surface (screen readers, tests). */
    ariaLabel?: string;
  }
>(function WikiBodyEditor(
  { value, onChange, placeholder, onUpload, name, onSubmitShortcut, ariaLabel = "Body" },
  ref,
) {
  // Track the latest value via ref so the editor's onUpdate can compare
  // without depending on the closure-captured prop (which would lag).
  const valueRef = useRef(value);
  valueRef.current = value;
  const onUploadRef = useRef(onUpload);
  onUploadRef.current = onUpload;

  const [mode, setMode] = useState<WikiBodyEditorMode>("edit");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [pickingPage, setPickingPage] = useState(false);

  const editor = useEditor({
    immediatelyRender: false, // SSR-friendly: avoid hydration mismatch
    extensions: [
      // StarterKit v2.x ships History, Paragraph, Heading, Bold, Italic,
      // Strike, Code, CodeBlock, Blockquote, BulletList, OrderedList,
      // ListItem, HorizontalRule, HardBreak, Document, Text, Dropcursor,
      // Gapcursor. Link/Image are NOT included by default — added below
      // so we control their config (open-on-click off, custom image
      // renderer for video/audio).
      StarterKit,
      LinkExt.configure({
        openOnClick: false,
        autolink: true,
        HTMLAttributes: { class: "text-brand-600 underline" },
      }),
      // Custom Image node that swaps to <video> / <audio> when the src URL
      // carries `?t=video` / `?t=audio`. Keeps the schema name "image" so
      // markdown round-trips as `![alt](url?...)`.
      //
      // `inline: true` is the important bit: it makes the image a child of
      // the paragraph node rather than a top-level block. The text caret
      // can then sit on either side of the image on the same line, exactly
      // like a character. Without it, clicking next to an image lands the
      // caret at the start of the paragraph BELOW the image (PM has no
      // valid position adjacent to a top-level block node), which looks to
      // the user like "the cursor moved to the line below the image".
      ImageExt.extend({
        inline: true,
        group: "inline",
        renderHTML({ HTMLAttributes }) {
          const attrs = HTMLAttributes as Record<string, unknown>;
          const src = typeof attrs.src === "string" ? attrs.src : "";
          const alt = typeof attrs.alt === "string" ? attrs.alt : "";
          const params = parseUrlParams(src);
          if (params.kind === "video") {
            return [
              "video",
              {
                src,
                controls: "true",
                preload: "metadata",
                class: "rounded-md border border-slate-300 dark:border-slate-800 max-w-full align-middle",
              },
            ];
          }
          if (params.kind === "audio") {
            return ["audio", { src, controls: "true", preload: "metadata", class: "w-full align-middle" }];
          }
          return [
            "img",
            {
              src,
              alt,
              class: "rounded-md border border-slate-300 dark:border-slate-800 max-w-full align-middle",
            },
          ];
        },
      }).configure({ inline: true, allowBase64: false }),
      Placeholder.configure({ placeholder: placeholder ?? "Start writing…" }),
      // Without these, a markdown GFM table has no matching ProseMirror node on
      // load: tiptap-markdown silently flattens it into one run of plain text
      // (losing every pipe/row break), and that flattened version is what gets
      // written back on the next save — even one touching an unrelated part of
      // the page. tiptap-markdown matches these by node name ("table" etc.) to
      // its own bundled parse/serialize spec, so no extra Markdown config is needed.
      // The bundled serializer writes the text "[table]" for any table that is
      // not strictly GFM-shaped (an Excel paste always is not), so override it.
      TableExt.extend({
        addAttributes() {
          return {
            ...this.parent?.(),
            // Per-table column borders; stored in the markdown as a comment
            // line above the table (see lib/wiki-table-markdown.ts).
            borders: {
              default: false,
              parseHTML: (el: HTMLElement) => el.getAttribute("data-borders") === "true",
              renderHTML: (attrs: Record<string, unknown>) =>
                attrs.borders ? { "data-borders": "true" } : {},
            },
            // First row styled as a header (tinted, bold).
            header: {
              default: false,
              parseHTML: (el: HTMLElement) => el.getAttribute("data-header") === "true",
              renderHTML: (attrs: Record<string, unknown>) =>
                attrs.header ? { "data-header": "true" } : {},
            },
            // Cell padding in px for the whole table; null = the stylesheet's.
            pad: {
              default: null,
              parseHTML: (el: HTMLElement) => parsePad(el.getAttribute("data-pad")),
              renderHTML: (attrs: Record<string, unknown>) => {
                const pad = parsePad(attrs.pad);
                return pad === null ? {} : { "data-pad": String(pad), style: tablePadCss(pad) };
              },
            },
          };
        },
        addStorage() {
          return {
            markdown: {
              serialize: serializeTable,
              parse: {
                // With html off the marker comment arrives as a paragraph of text.
                updateDOM: applyTableMetaToDom,
              },
            },
          };
        },
      }).configure({ resizable: false }),
      TableRowExt,
      TableHeaderExt.extend({ addAttributes: cellBgAttributes }),
      TableCellExt.extend({ addAttributes: cellBgAttributes }),
      Markdown.configure({
        html: false,
        tightLists: true,
        linkify: true,
        breaks: false,
      }),
    ],
    content: value,
    editorProps: {
      attributes: {
        // ProseMirror renders a bare contenteditable div; give it a textbox
        // role and a name so assistive tech (and the e2e suite) can find it.
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": ariaLabel,
        class:
          "prose prose-slate max-w-none dark:prose-invert min-h-[18rem] px-4 py-3 focus:outline-none prose-headings:font-semibold prose-a:text-brand-600 prose-pre:bg-slate-900 prose-pre:text-slate-100 dark:prose-pre:bg-slate-950 prose-code:before:content-none prose-code:after:content-none",
      },
      // Triple-click in a table cell: prosemirror-tables turns it into a
      // CellSelection, which hides the text selection and (unstyled) looks like
      // nothing happened. Select the cell's text instead, like a paragraph.
      // Editor props run before plugin props, so this wins.
      handleTripleClick(view, pos) {
        const $pos = view.state.doc.resolve(pos);
        for (let d = $pos.depth; d > 0; d--) {
          const role = $pos.node(d).type.spec.tableRole;
          if (role !== "cell" && role !== "header_cell") continue;
          const doc = view.state.doc;
          const sel = TextSelection.between(doc.resolve($pos.start(d)), doc.resolve($pos.end(d)));
          view.dispatch(view.state.tr.setSelection(sel));
          return true;
        }
        return false;
      },
      handlePaste(_view, event) {
        const files = Array.from(event.clipboardData?.files ?? []);
        if (files.length === 0) return false;
        if (!onUploadRef.current) {
          setUploadError("Save the page first, then paste or drop files.");
          event.preventDefault();
          return true;
        }
        event.preventDefault();
        void uploadFilesAt(files, null);
        return true;
      },
      handleDrop(view, event, _slice, moved) {
        // Internal drags (an existing image being relocated) come through
        // here with `moved === true`. The browser also fills
        // `dataTransfer.files` with the image bytes in that case, so we
        // MUST check `moved` first — otherwise the file-upload branch
        // below fires and we end up duplicating the image instead of
        // moving it. Returning false lets ProseMirror's default handler
        // do the move (cut from source, insert at target).
        if (moved) return false;
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (files.length === 0) return false;
        if (!onUploadRef.current) {
          setUploadError("Save the page first, then paste or drop files.");
          event.preventDefault();
          return true;
        }
        event.preventDefault();
        // Resolve the ProseMirror position under the cursor so the upload
        // splices at the actual drop point, not the previous selection.
        const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
        void uploadFilesAt(files, coords?.pos ?? null);
        return true;
      },
    },
    onUpdate({ editor }) {
      // tiptap-markdown stores its parser/serializer on editor.storage.markdown.
      const md =
        (editor.storage as { markdown?: { getMarkdown(): string } }).markdown?.getMarkdown() ?? "";
      if (md === valueRef.current) return;
      onChange(md);
    },
  });

  // Sync external value changes back into the editor (e.g. when the parent
  // resets the form). Skip when the value matches what the editor already
  // produces so we don't fight the user's edits.
  useEffect(() => {
    if (!editor) return;
    const current =
      (editor.storage as { markdown?: { getMarkdown(): string } }).markdown?.getMarkdown() ?? "";
    if (current === value) return;
    editor.commands.setContent(value, false);
  }, [editor, value]);

  // ---- Imperative API for AttachmentList "+ Insert" ----------------------

  useImperativeHandle(
    ref,
    () => ({
      focus() {
        editor?.commands.focus();
      },
      insertAtCaret(text) {
        if (!editor) return;
        // insertContent with a markdown string lets tiptap-markdown parse it
        // and splice the resulting nodes at the caret — works for images,
        // links, paragraphs, etc.
        editor.chain().focus().insertContent(text + "\n\n").run();
      },
    }),
    [editor],
  );

  // ---- Upload helper -----------------------------------------------------

  /**
   * Upload each file in sequence, splicing the resulting markdown snippet
   * at `startPos` (a ProseMirror position) or at the current caret if null.
   * Successive files insert immediately after the previous so multi-file
   * drops keep selection order.
   */
  async function uploadFilesAt(files: File[], startPos: number | null) {
    if (!editor) return;
    const upload = onUploadRef.current;
    if (!upload) return;
    setUploadError(null);
    setUploading(true);
    let failed = 0;
    try {
      // Anchor at the requested position once; subsequent inserts ride the
      // editor's own caret because each insertContent moves it forward.
      if (startPos != null) {
        editor.chain().focus().setTextSelection(startPos).run();
      } else {
        editor.commands.focus();
      }
      for (const file of files) {
        try {
          const snippet = await upload(file);
          if (snippet === null) {
            failed++;
            continue;
          }
          // Block-style media (![alt](url)) gets a blank line padding so it
          // doesn't fuse with surrounding paragraphs. Plain links stay
          // inline; insertContent handles either.
          const isBlock = snippet.startsWith("!");
          editor.chain().focus().insertContent(isBlock ? snippet + "\n\n" : snippet).run();
        } catch {
          failed++;
        }
      }
      if (failed > 0) {
        setUploadError(
          failed === files.length
            ? "Upload failed."
            : `${failed} of ${files.length} file(s) failed to upload.`,
        );
      }
    } finally {
      setUploading(false);
    }
  }

  function pickFile() {
    if (!onUpload) {
      setUploadError("Save the page first, then attach files.");
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "*/*";
    input.multiple = true;
    input.onchange = () => {
      const fs = Array.from(input.files ?? []);
      if (fs.length) void uploadFilesAt(fs, null);
    };
    input.click();
  }

  function insertLink() {
    if (!editor) return;
    const url = window.prompt("Link URL", "https://");
    if (!url) return;
    if (editor.state.selection.empty) {
      editor.chain().focus().insertContent(`[link](${url})`).run();
    } else {
      editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
    }
  }

  function pickPage() {
    if (editor) setPickingPage(true);
  }

  function insertPageLink(page: PickedWikiPage) {
    setPickingPage(false);
    if (!editor) return;
    editor
      .chain()
      .focus()
      .insertContent([
        { type: "text", text: page.title, marks: [{ type: "link", attrs: { href: `/wiki/${page.id}` } }] },
        { type: "text", text: " " },
      ])
      .run();
  }

  // ---- Cmd/Ctrl+Enter submit + Cmd+B/I shortcuts handled by StarterKit ---

  useEffect(() => {
    if (!editor || !onSubmitShortcut) return;
    const dom = editor.view.dom;
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        onSubmitShortcut?.();
      }
    }
    dom.addEventListener("keydown", onKeyDown);
    return () => dom.removeEventListener("keydown", onKeyDown);
  }, [editor, onSubmitShortcut]);

  // ---- Slash menu (block picker) ----------------------------------------

  const [slash, setSlash] = useState<{ x: number; y: number; filter: string; hover: number } | null>(
    null,
  );
  const filteredSlashItems = useMemo(() => {
    if (!slash) return SLASH_ITEMS;
    const f = slash.filter.toLowerCase().trim();
    if (!f) return SLASH_ITEMS;
    return SLASH_ITEMS.filter(
      (it) => it.key.includes(f) || it.label.toLowerCase().includes(f) || it.keywords.includes(f),
    );
  }, [slash]);

  // Detect "/" at the start of an empty block and open the menu.
  useEffect(() => {
    if (!editor) return;
    function checkSlash() {
      const { state, view } = editor!;
      const { $from } = state.selection;
      if (!state.selection.empty) {
        setSlash(null);
        return;
      }
      const text = $from.parent.textContent;
      if (!text.startsWith("/")) {
        setSlash(null);
        return;
      }
      const filter = text.slice(1);
      // Anchor coords for the menu. Use coordsAtPos at the start of the block.
      const start = $from.start();
      const coords = view.coordsAtPos(start);
      const rect = view.dom.getBoundingClientRect();
      setSlash((prev) => ({
        x: coords.left - rect.left,
        y: coords.bottom - rect.top + 4,
        filter,
        hover: prev?.hover ?? 0,
      }));
    }
    editor.on("transaction", checkSlash);
    editor.on("selectionUpdate", checkSlash);
    return () => {
      editor.off("transaction", checkSlash);
      editor.off("selectionUpdate", checkSlash);
    };
  }, [editor]);

  function applySlash(item: SlashItem) {
    if (!editor) return;
    // Wipe the "/filter" text from the active paragraph, then run the
    // chosen command.
    const { $from } = editor.state.selection;
    const start = $from.start();
    editor
      .chain()
      .focus()
      .setTextSelection({ from: start, to: $from.pos })
      .deleteSelection()
      .run();
    setSlash(null);
    setTimeout(() => item.run({ editor: editor!, pickFile, insertLink, pickPage }), 0);
  }

  // Capture nav keys while the slash menu is open.
  useEffect(() => {
    if (!editor || !slash) return;
    const dom = editor.view.dom;
    function onKeyDown(e: KeyboardEvent) {
      if (!slash) return;
      const items = filteredSlashItems;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlash((s) => (s ? { ...s, hover: (s.hover + 1) % Math.max(items.length, 1) } : s));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlash((s) =>
          s
            ? { ...s, hover: (s.hover - 1 + Math.max(items.length, 1)) % Math.max(items.length, 1) }
            : s,
        );
      } else if (e.key === "Enter") {
        const choice = filteredSlashItems[slash.hover] ?? filteredSlashItems[0];
        if (choice) {
          e.preventDefault();
          applySlash(choice);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        setSlash(null);
      }
    }
    dom.addEventListener("keydown", onKeyDown, true);
    return () => dom.removeEventListener("keydown", onKeyDown, true);
  });

  /**
 * Cell background for the table cell and header extensions: `bg` is
 * "#rrggbb@opacity" (null = none), saved in the page's table marker comment.
 * Shared by both so a header cell can be coloured like any other.
 */
function cellBgAttributes(this: { parent?: () => Record<string, unknown> }) {
  return {
    ...this.parent?.(),
    bg: {
      default: null,
      parseHTML: (el: HTMLElement) => parseBgAttr(el.getAttribute("data-bg")) && el.getAttribute("data-bg"),
      renderHTML: (attrs: Record<string, unknown>) => {
        const bg = parseBgAttr(attrs.bg);
        return bg
          ? { "data-bg": formatBgAttr(bg), style: `background-color: ${cellBackgroundCss(bg)}` }
          : {};
      },
    },
  };
}

// ---- Table floating toolbar (Confluence-style add/delete row/column) --

  const [tableMenu, setTableMenu] = useState<TableMenuPos | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!editor) return;
    const show = (next: TableMenuPos | null) =>
      setTableMenu((prev) => (prev && next && prev.x === next.x && prev.y === next.y ? prev : next));
    function checkTable() {
      const ed = editor!;
      if (!ed.isActive("table")) {
        show(null);
        return;
      }
      const { $from } = ed.state.selection;
      let tableDepth = -1;
      for (let d = $from.depth; d > 0; d--) {
        if ($from.node(d).type.name === "table") {
          tableDepth = d;
          break;
        }
      }
      const tableDom = tableDepth < 0 ? null : (ed.view.nodeDOM($from.before(tableDepth)) as HTMLElement | null);
      if (!tableDom) {
        show(null);
        return;
      }
      const tableRect = tableDom.getBoundingClientRect();
      // Viewport coordinates. The menu is rendered on document.body (see
      // TableFloatingMenu): the wiki's .fx-surface puts backdrop-filter on
      // .bg-white panels, which makes them the containing block for any fixed
      // descendant, so a fixed menu inside the editor scrolled with it.
      // It sits just above the table, but never higher than just below the
      // (sticky) main toolbar, until the table's last row comes up.
      const stickAt = (toolbarRef.current?.getBoundingClientRect().bottom ?? 0) + 4;
      const natural = tableRect.top - TABLE_MENU_H;
      const lastTop = tableRect.bottom - TABLE_MENU_H;
      if (lastTop < stickAt || natural > window.innerHeight) {
        show(null);
        return;
      }
      show({ x: Math.max(0, tableRect.left), y: Math.min(Math.max(natural, stickAt), lastTop) });
    }
    const onScroll = () => checkTable();
    editor.on("transaction", checkTable);
    editor.on("selectionUpdate", checkTable);
    window.addEventListener("scroll", onScroll, { passive: true, capture: true });
    window.addEventListener("resize", onScroll);
    checkTable();
    return () => {
      editor.off("transaction", checkTable);
      editor.off("selectionUpdate", checkTable);
      window.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", onScroll);
    };
  }, [editor]);

  // ---- Source mode (raw markdown textarea) ------------------------------

  function onSourceChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    onChange(e.target.value);
    // Don't update the editor here — the useEffect on `value` will re-sync
    // when the user switches back to "edit" mode.
  }

  if (!editor) {
    // useEditor returns null on the SSR pass with immediatelyRender:false.
    return (
      <div className="rounded-md border border-slate-300 px-4 py-3 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
        Loading editor…
      </div>
    );
  }

  return (
    <div className="rounded-md border border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-950">
      {/* Hidden mirror for any legacy <form>-FormData consumer. */}
      {name ? <input type="hidden" name={name} value={value} readOnly /> : null}

      <Toolbar
        ref={toolbarRef}
        editor={editor}
        mode={mode}
        setMode={setMode}
        uploading={uploading}
        pickFile={pickFile}
        canUpload={Boolean(onUpload)}
        insertLink={insertLink}
        pickPage={pickPage}
      />

      {(uploading || uploadError) && (
        <div className="border-b border-slate-300 bg-slate-50 px-3 py-1 text-xs dark:border-slate-800 dark:bg-slate-900">
          {uploading ? (
            <span className="text-slate-500">Uploading…</span>
          ) : uploadError ? (
            <span className="text-rose-600 dark:text-rose-400">{uploadError}</span>
          ) : null}
        </div>
      )}

      {mode === "source" ? (
        <textarea
          value={value}
          onChange={onSourceChange}
          rows={18}
          maxLength={200_000}
          spellCheck
          className="block w-full resize-y border-0 bg-transparent px-4 py-3 font-mono text-sm leading-6 outline-none focus:ring-0 dark:bg-transparent"
        />
      ) : (
        <div className="relative">
          <EditorContent editor={editor} />
          {tableMenu ? <TableFloatingMenu editor={editor} pos={tableMenu} /> : null}
          {slash && filteredSlashItems.length > 0 ? (
            <SlashMenu
              items={filteredSlashItems}
              hover={slash.hover}
              x={slash.x}
              y={slash.y}
              onPick={(i) => applySlash(filteredSlashItems[i]!)}
              onClose={() => setSlash(null)}
            />
          ) : null}
        </div>
      )}

      {pickingPage ? <WikiPagePicker onPick={insertPageLink} onClose={() => setPickingPage(false)} /> : null}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-b-md border-t border-slate-300 bg-slate-50 px-3 py-1 text-[11px] text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
        <span>Type <code className="rounded bg-slate-200 px-1 dark:bg-slate-800">/</code> on a blank line for blocks</span>
        <span>Ctrl/Cmd+B bold · Ctrl/Cmd+I italic · Ctrl/Cmd+K link</span>
        <span>Click inside a table for row/column controls</span>
        {onUpload ? <span>Drop or paste any file — it lands at the cursor</span> : null}
      </div>
    </div>
  );
});

// ---- Toolbar -------------------------------------------------------------

const Toolbar = forwardRef<
  HTMLDivElement,
  {
    editor: Editor;
    mode: WikiBodyEditorMode;
    setMode: (m: WikiBodyEditorMode) => void;
    uploading: boolean;
    pickFile: () => void;
    canUpload: boolean;
    insertLink: () => void;
    pickPage: () => void;
  }
>(function Toolbar({ editor, mode, setMode, uploading, pickFile, canUpload, insertLink, pickPage }, ref) {
  const sourceMode = mode === "source";
  const c = useCallback(
    (fn: (chain: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>) => () =>
      fn(editor.chain().focus()).run(),
    [editor],
  );
  return (
    <div ref={ref} className="sticky top-0 z-10 flex flex-wrap items-center gap-0.5 rounded-t-md border-b border-slate-300 bg-slate-50 px-2 py-1.5 dark:border-slate-800 dark:bg-slate-900">
      <ToolBtn
        title="Bold (Ctrl/Cmd+B)"
        onClick={c((chain) => chain.toggleBold())}
        active={editor.isActive("bold")}
        disabled={sourceMode}
      >
        <Bold className="h-4 w-4" />
      </ToolBtn>
      <ToolBtn
        title="Italic (Ctrl/Cmd+I)"
        onClick={c((chain) => chain.toggleItalic())}
        active={editor.isActive("italic")}
        disabled={sourceMode}
      >
        <Italic className="h-4 w-4" />
      </ToolBtn>
      <ToolBtn
        title="Strikethrough"
        onClick={c((chain) => chain.toggleStrike())}
        active={editor.isActive("strike")}
        disabled={sourceMode}
      >
        <Strikethrough className="h-4 w-4" />
      </ToolBtn>
      <ToolDivider />
      <ToolBtn
        title="Heading 1"
        onClick={c((chain) => chain.toggleHeading({ level: 1 }))}
        active={editor.isActive("heading", { level: 1 })}
        disabled={sourceMode}
      >
        <Heading1 className="h-4 w-4" />
      </ToolBtn>
      <ToolBtn
        title="Heading 2"
        onClick={c((chain) => chain.toggleHeading({ level: 2 }))}
        active={editor.isActive("heading", { level: 2 })}
        disabled={sourceMode}
      >
        <Heading2 className="h-4 w-4" />
      </ToolBtn>
      <ToolBtn
        title="Heading 3"
        onClick={c((chain) => chain.toggleHeading({ level: 3 }))}
        active={editor.isActive("heading", { level: 3 })}
        disabled={sourceMode}
      >
        <Heading3 className="h-4 w-4" />
      </ToolBtn>
      <ToolDivider />
      <ToolBtn
        title="Bulleted list"
        onClick={c((chain) => chain.toggleBulletList())}
        active={editor.isActive("bulletList")}
        disabled={sourceMode}
      >
        <List className="h-4 w-4" />
      </ToolBtn>
      <ToolBtn
        title="Numbered list"
        onClick={c((chain) => chain.toggleOrderedList())}
        active={editor.isActive("orderedList")}
        disabled={sourceMode}
      >
        <ListOrdered className="h-4 w-4" />
      </ToolBtn>
      <ToolBtn
        title="Quote"
        onClick={c((chain) => chain.toggleBlockquote())}
        active={editor.isActive("blockquote")}
        disabled={sourceMode}
      >
        <Quote className="h-4 w-4" />
      </ToolBtn>
      <ToolDivider />
      <ToolBtn
        title="Inline code"
        onClick={c((chain) => chain.toggleCode())}
        active={editor.isActive("code")}
        disabled={sourceMode}
      >
        <Code className="h-4 w-4" />
      </ToolBtn>
      <ToolBtn
        title="Code block"
        onClick={c((chain) => chain.toggleCodeBlock())}
        active={editor.isActive("codeBlock")}
        disabled={sourceMode}
      >
        <Code2 className="h-4 w-4" />
      </ToolBtn>
      <ToolDivider />
      <ToolBtn title="Link (Ctrl/Cmd+K)" onClick={insertLink} disabled={sourceMode}>
        <LinkIcon className="h-4 w-4" />
      </ToolBtn>
      <ToolBtn title="Link to a wiki page" onClick={pickPage} disabled={sourceMode}>
        <FileText className="h-4 w-4" />
      </ToolBtn>
      <ToolBtn
        title={canUpload ? "Upload file (image / video / audio / PDF / etc.)" : "Save the page first to attach files"}
        onClick={pickFile}
        disabled={uploading || !canUpload || sourceMode}
      >
        <ImagePlus className="h-4 w-4" />
      </ToolBtn>
      <ToolBtn
        title="Horizontal divider"
        onClick={c((chain) => chain.setHorizontalRule())}
        disabled={sourceMode}
      >
        <Minus className="h-4 w-4" />
      </ToolBtn>
      <ToolBtn
        title="Insert table"
        onClick={c((chain) => chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }))}
        disabled={sourceMode}
      >
        <TableIcon className="h-4 w-4" />
      </ToolBtn>
      <ToolDivider />
      <ToolBtn
        title="Undo"
        onClick={c((chain) => chain.undo())}
        disabled={sourceMode || !editor.can().undo()}
      >
        <Undo2 className="h-4 w-4" />
      </ToolBtn>
      <ToolBtn
        title="Redo"
        onClick={c((chain) => chain.redo())}
        disabled={sourceMode || !editor.can().redo()}
      >
        <Redo2 className="h-4 w-4" />
      </ToolBtn>

      <div className="ml-auto flex items-center gap-0.5 rounded-md border border-slate-300 bg-white p-0.5 dark:border-slate-700 dark:bg-slate-950">
        <ModeBtn current={mode} mode="edit" set={setMode} title="Visual editor">
          <Pencil className="h-3.5 w-3.5" />
        </ModeBtn>
        <ModeBtn current={mode} mode="source" set={setMode} title="Markdown source">
          <Code className="h-3.5 w-3.5" />
        </ModeBtn>
      </div>
    </div>
  );
});

function ToolBtn({
  title,
  onClick,
  active,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={
        "inline-flex h-7 w-7 items-center justify-center rounded text-slate-600 hover:bg-slate-200 disabled:opacity-40 dark:text-slate-300 dark:hover:bg-slate-700 " +
        (active ? "bg-slate-200 text-slate-900 dark:bg-slate-700 dark:text-white" : "")
      }
    >
      {children}
    </button>
  );
}

function ToolDivider() {
  return <span className="mx-1 inline-block h-5 w-px bg-slate-200 dark:bg-slate-700" aria-hidden />;
}

function ModeBtn({
  current,
  mode,
  set,
  title,
  children,
}: {
  current: WikiBodyEditorMode;
  mode: WikiBodyEditorMode;
  set: (m: WikiBodyEditorMode) => void;
  title: string;
  children: React.ReactNode;
}) {
  const active = current === mode;
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => set(mode)}
      className={
        "inline-flex h-6 w-7 items-center justify-center rounded " +
        (active
          ? "bg-brand-600 text-white"
          : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800")
      }
    >
      {children}
    </button>
  );
}

// Stub kept so the unused-icon-import lint doesn't fire on Eye.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _PreviewIconRef = Eye;

// ---- Slash menu -----------------------------------------------------------

interface SlashCtx {
  editor: Editor;
  pickFile: () => void;
  insertLink: () => void;
  pickPage: () => void;
}
interface SlashItem {
  key: string;
  label: string;
  hint: string;
  keywords: string;
  run: (ctx: SlashCtx) => void;
}

const SLASH_ITEMS: SlashItem[] = [
  {
    key: "h1",
    label: "Heading 1",
    hint: "Large section heading",
    keywords: "h1 heading title",
    run: ({ editor }) => editor.chain().focus().setHeading({ level: 1 }).run(),
  },
  {
    key: "h2",
    label: "Heading 2",
    hint: "Section heading",
    keywords: "h2 heading",
    run: ({ editor }) => editor.chain().focus().setHeading({ level: 2 }).run(),
  },
  {
    key: "h3",
    label: "Heading 3",
    hint: "Sub-section",
    keywords: "h3 heading",
    run: ({ editor }) => editor.chain().focus().setHeading({ level: 3 }).run(),
  },
  {
    key: "ul",
    label: "Bulleted list",
    hint: "Unordered list",
    keywords: "list bullet ul",
    run: ({ editor }) => editor.chain().focus().toggleBulletList().run(),
  },
  {
    key: "ol",
    label: "Numbered list",
    hint: "Ordered list",
    keywords: "list numbered ol",
    run: ({ editor }) => editor.chain().focus().toggleOrderedList().run(),
  },
  {
    key: "quote",
    label: "Quote",
    hint: "Quoted paragraph",
    keywords: "quote blockquote",
    run: ({ editor }) => editor.chain().focus().toggleBlockquote().run(),
  },
  {
    key: "code",
    label: "Code block",
    hint: "Monospaced block",
    keywords: "code pre block",
    run: ({ editor }) => editor.chain().focus().toggleCodeBlock().run(),
  },
  {
    key: "hr",
    label: "Divider",
    hint: "Horizontal rule",
    keywords: "divider hr separator",
    run: ({ editor }) => editor.chain().focus().setHorizontalRule().run(),
  },
  {
    key: "link",
    label: "Link",
    hint: "Prompt for URL",
    keywords: "link url",
    run: ({ insertLink }) => insertLink(),
  },
  {
    key: "page",
    label: "Wiki page",
    hint: "Link to another page",
    keywords: "page wiki link reference",
    run: ({ pickPage }) => pickPage(),
  },
  {
    key: "image",
    label: "File / image / video",
    hint: "Upload & embed at the cursor",
    keywords: "image picture upload media file pdf audio attachment",
    run: ({ pickFile }) => pickFile(),
  },
];

function SlashMenu({
  items,
  hover,
  x,
  y,
  onPick,
  onClose,
}: {
  items: SlashItem[];
  hover: number;
  x: number;
  y: number;
  onPick: (i: number) => void;
  onClose: () => void;
}) {
  return (
    <div
      role="menu"
      onMouseDown={(e) => e.preventDefault()}
      style={{ left: x, top: y }}
      className="absolute z-20 max-h-72 w-64 overflow-auto rounded-md border border-slate-300 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900"
    >
      <ul className="py-1 text-sm">
        {items.map((it, i) => (
          <li key={it.key}>
            <button
              type="button"
              onClick={() => onPick(i)}
              className={
                "block w-full px-3 py-1.5 text-left " +
                (i === hover
                  ? "bg-brand-50 text-brand-800 dark:bg-brand-700/30 dark:text-brand-100"
                  : "hover:bg-slate-50 dark:hover:bg-slate-800")
              }
            >
              <div className="font-medium">{it.label}</div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400">{it.hint}</div>
            </button>
          </li>
        ))}
      </ul>
      <div className="border-t border-slate-300 px-3 py-1 text-[10px] text-slate-500 dark:border-slate-800 dark:text-slate-400">
        ↑/↓ to navigate · Enter to insert ·{" "}
        <button type="button" onClick={onClose} className="underline">
          Esc
        </button>{" "}
        to dismiss
      </div>
    </div>
  );
}

// ---- Table floating toolbar ------------------------------------------------

/** Height the table menu needs above a table (its own height plus a gap). */
const TABLE_MENU_H = 34;

/** Where the table menu sits, in viewport coordinates. */
interface TableMenuPos {
  x: number;
  y: number;
}

/**
 * Confluence-style contextual toolbar for the table the caret is currently
 * inside: add/delete rows and columns, cell colour, borders, header row,
 * padding, and remove the whole table, without dropping into markdown source.
 * Sits just above the active table and scrolls with it like a caption, but
 * once the table's top goes under the main toolbar it sticks below that
 * toolbar until the table itself scrolls away (recomputed on selection
 * changes and scrolling, see the effect in WikiBodyEditor).
 */
function TableFloatingMenu({ editor, pos }: { editor: Editor; pos: TableMenuPos }) {
  function run(fn: (chain: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>) {
    fn(editor.chain().focus()).run();
  }
  const tableAttrs = editor.getAttributes("table");
  const borders = tableAttrs.borders === true;
  const header = tableAttrs.header === true;
  return createPortal(
    <div
      onMouseDown={(e) => e.preventDefault()}
      style={{ left: pos.x, top: pos.y }}
      className={`fixed z-30 flex items-center gap-0.5 rounded-md border border-slate-300 bg-white p-0.5 shadow-md dark:border-slate-700 dark:bg-slate-900`}
    >
      <TableBtn
        title="Insert row above"
        onClick={() => run((c) => c.addRowBefore())}
        disabled={!editor.can().addRowBefore()}
      >
        <ArrowUpToLine className="h-3.5 w-3.5" />
      </TableBtn>
      <TableBtn
        title="Insert row below"
        onClick={() => run((c) => c.addRowAfter())}
        disabled={!editor.can().addRowAfter()}
      >
        <ArrowDownToLine className="h-3.5 w-3.5" />
      </TableBtn>
      <TableBtn
        title="Delete this row"
        onClick={() => run((c) => c.deleteRow())}
        disabled={!editor.can().deleteRow()}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </TableBtn>
      <ToolDivider />
      <TableBtn
        title="Insert column left"
        onClick={() => run((c) => c.addColumnBefore())}
        disabled={!editor.can().addColumnBefore()}
      >
        <ArrowLeftToLine className="h-3.5 w-3.5" />
      </TableBtn>
      <TableBtn
        title="Insert column right"
        onClick={() => run((c) => c.addColumnAfter())}
        disabled={!editor.can().addColumnAfter()}
      >
        <ArrowRightToLine className="h-3.5 w-3.5" />
      </TableBtn>
      <TableBtn
        title="Delete this column"
        onClick={() => run((c) => c.deleteColumn())}
        disabled={!editor.can().deleteColumn()}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </TableBtn>
      <ToolDivider />
      <CellColorMenu editor={editor} />
      <TableBtn
        title={borders ? "Hide column borders" : "Show column borders"}
        pressed={borders}
        onClick={() => run((c) => c.updateAttributes("table", { borders: !borders }))}
      >
        <Columns3 className="h-3.5 w-3.5" />
      </TableBtn>
      <TableBtn
        title={header ? "First row is a header (click to make it a normal row)" : "My table has a header row"}
        pressed={header}
        onClick={() => run((c) => c.updateAttributes("table", { header: !header }))}
      >
        <PanelTop className="h-3.5 w-3.5" />
      </TableBtn>
      <TablePadInput editor={editor} pad={parsePad(tableAttrs.pad)} />
      <ToolDivider />
      <TableBtn
        title="Delete table"
        onClick={() => run((c) => c.deleteTable())}
        disabled={!editor.can().deleteTable()}
      >
        <TableIcon className="h-3.5 w-3.5" />
        <Trash2 className="-ml-1 h-3 w-3" />
      </TableBtn>
    </div>,
    document.body,
  );
}

/**
 * Cell padding (px) for the whole table. Blank = the default. Typing needs the
 * input's own focus, so it stops the menu's focus-keeping mousedown handler and
 * changes the table without refocusing the editor (its selection survives the
 * blur, so `updateAttributes("table")` still finds the table).
 */
function TablePadInput({ editor, pad }: { editor: Editor; pad: number | null }) {
  const [draft, setDraft] = useState<string | null>(null);
  function change(text: string) {
    setDraft(text);
    const n = text.trim() === "" ? null : parsePad(Number(text));
    if (text.trim() !== "" && n === null) return;
    editor.chain().updateAttributes("table", { pad: n }).run();
  }
  return (
    <label
      onMouseDown={(e) => e.stopPropagation()}
      title={`Cell padding for the whole table, 0 to ${MAX_TABLE_PAD} px (blank = ${DEFAULT_TABLE_PAD})`}
      className="inline-flex h-6 items-center gap-1 rounded px-1 text-[11px] text-slate-600 dark:text-slate-300"
    >
      Padding
      <input
        type="number"
        inputMode="numeric"
        min={0}
        max={MAX_TABLE_PAD}
        step={1}
        placeholder={String(DEFAULT_TABLE_PAD)}
        aria-label="Table cell padding in pixels"
        value={draft ?? (pad === null ? "" : String(pad))}
        onChange={(e) => change(e.target.value)}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "Escape") {
            e.preventDefault();
            setDraft(null);
            editor.commands.focus();
          }
        }}
        className="h-5 w-12 rounded border border-slate-300 bg-white px-1 py-0 text-[11px] tabular-nums dark:border-slate-600 dark:bg-slate-950"
      />
    </label>
  );
}

const CELL_SWATCHES = ["#fde047", "#fdba74", "#fca5a5", "#f9a8d4", "#c4b5fd", "#93c5fd", "#86efac", "#cbd5e1"];

/**
 * Background colour and opacity for the selected table cells (click a cell, or
 * drag across several). Every change applies at once; "No colour" clears it.
 * Opens its own panel, which must keep native mouse behaviour (a range slider
 * cannot be dragged if mousedown is cancelled), so it stops the toolbar's
 * focus-keeping handler; the editor selection survives the blur.
 */
function CellColorMenu({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const [color, setColor] = useState("#fde047");
  const [opacity, setOpacity] = useState(40);
  const ref = useRef<HTMLDivElement>(null);
  const current = parseBgAttr(editor.getAttributes("tableCell").bg ?? editor.getAttributes("tableHeader").bg);

  useEffect(() => {
    if (!open) return;
    function away(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  function apply(c: string, o: number) {
    setColor(c);
    setOpacity(o);
    editor.chain().focus().setCellAttribute("bg", formatBgAttr({ color: c, opacity: o })).run();
  }

  return (
    <div ref={ref} className="relative">
      <TableBtn
        title="Cell background colour"
        pressed={open}
        onClick={() => {
          if (!open && current) {
            setColor(current.color);
            setOpacity(current.opacity);
          }
          setOpen((v) => !v);
        }}
      >
        <PaintBucket className="h-3.5 w-3.5" />
        <span
          className="ml-0.5 h-2.5 w-2.5 rounded-sm border border-slate-400"
          style={current ? { background: cellBackgroundCss(current) } : undefined}
        />
      </TableBtn>
      {open ? (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          className="absolute left-0 top-full z-30 mt-1 w-64 rounded-md border border-slate-300 bg-white p-2 text-xs shadow-lg dark:border-slate-700 dark:bg-slate-900"
        >
          <div className="mb-2 flex flex-wrap items-center gap-1">
            {CELL_SWATCHES.map((c) => (
              <button
                key={c}
                type="button"
                title={c}
                aria-label={`Colour ${c}`}
                onClick={() => apply(c, opacity)}
                className={`h-5 w-5 rounded border ${
                  current?.color === c ? "ring-2 ring-brand-500" : "border-slate-300 dark:border-slate-600"
                }`}
                style={{ background: c }}
              />
            ))}
            <input
              type="color"
              aria-label="Custom colour"
              value={color}
              onChange={(e) => apply(e.target.value, opacity)}
              className="h-5 w-7 cursor-pointer rounded border border-slate-300 bg-transparent p-0 dark:border-slate-600"
            />
          </div>
          <label className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
            Opacity
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={opacity}
              aria-label="Opacity"
              onChange={(e) => apply(color, Number(e.target.value))}
              className="min-w-0 flex-1"
            />
            <span className="w-8 text-right tabular-nums">{opacity}%</span>
          </label>
          <button
            type="button"
            onClick={() => editor.chain().focus().setCellAttribute("bg", null).run()}
            className="mt-2 w-full rounded border border-slate-300 py-0.5 text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            No colour
          </button>
        </div>
      ) : null}
    </div>
  );
}

function TableBtn({
  title,
  onClick,
  disabled,
  pressed,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={pressed}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`inline-flex h-6 items-center gap-0 rounded px-1 ${pressed ? "bg-slate-200 dark:bg-slate-700" : ""} text-slate-600 hover:bg-slate-200 disabled:opacity-30 disabled:hover:bg-transparent dark:text-slate-300 dark:hover:bg-slate-700`}
    >
      {children}
    </button>
  );
}

// ---- Helpers --------------------------------------------------------------

function parseUrlParams(url: string): { kind: "image" | "video" | "audio" } {
  const qIdx = url.indexOf("?");
  if (qIdx < 0) return { kind: "image" };
  const params = new URLSearchParams(url.slice(qIdx + 1));
  const t = params.get("t");
  return { kind: t === "video" ? "video" : t === "audio" ? "audio" : "image" };
}
