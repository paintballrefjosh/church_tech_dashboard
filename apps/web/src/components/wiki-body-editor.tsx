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
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import LinkExt from "@tiptap/extension-link";
import ImageExt from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import TableExt from "@tiptap/extension-table";
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
  ImagePlus,
  Minus,
  Table as TableIcon,
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
      TableExt.configure({ resizable: false }),
      TableRowExt,
      TableHeaderExt,
      TableCellExt,
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
    setTimeout(() => item.run({ editor: editor!, pickFile, insertLink }), 0);
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

  // ---- Table floating toolbar (Confluence-style add/delete row/column) --

  const [tableMenu, setTableMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!editor) return;
    function checkTable() {
      const ed = editor!;
      if (!ed.isActive("table")) {
        setTableMenu(null);
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
      if (tableDepth < 0) {
        setTableMenu(null);
        return;
      }
      const tableDom = ed.view.nodeDOM($from.before(tableDepth)) as HTMLElement | null;
      if (!tableDom) {
        setTableMenu(null);
        return;
      }
      const tableRect = tableDom.getBoundingClientRect();
      const containerRect = ed.view.dom.getBoundingClientRect();
      setTableMenu({
        x: Math.max(0, tableRect.left - containerRect.left),
        // Clamp to 0 so a table at the very top of the document doesn't push
        // the toolbar above the editor's own content area.
        y: Math.max(0, tableRect.top - containerRect.top - 34),
      });
    }
    editor.on("transaction", checkTable);
    editor.on("selectionUpdate", checkTable);
    checkTable();
    return () => {
      editor.off("transaction", checkTable);
      editor.off("selectionUpdate", checkTable);
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
        editor={editor}
        mode={mode}
        setMode={setMode}
        uploading={uploading}
        pickFile={pickFile}
        canUpload={Boolean(onUpload)}
        insertLink={insertLink}
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
          {tableMenu ? (
            <TableFloatingMenu editor={editor} x={tableMenu.x} y={tableMenu.y} />
          ) : null}
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

function Toolbar({
  editor,
  mode,
  setMode,
  uploading,
  pickFile,
  canUpload,
  insertLink,
}: {
  editor: Editor;
  mode: WikiBodyEditorMode;
  setMode: (m: WikiBodyEditorMode) => void;
  uploading: boolean;
  pickFile: () => void;
  canUpload: boolean;
  insertLink: () => void;
}) {
  const sourceMode = mode === "source";
  const c = useCallback(
    (fn: (chain: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>) => () =>
      fn(editor.chain().focus()).run(),
    [editor],
  );
  return (
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-0.5 rounded-t-md border-b border-slate-300 bg-slate-50 px-2 py-1.5 dark:border-slate-800 dark:bg-slate-900">
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
}

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

/**
 * Confluence-style contextual toolbar for the table the caret is currently
 * inside: add/delete rows and columns, and remove the whole table, without
 * dropping into markdown source. Positioned just above the active table
 * (recomputed on every selection change, see the effect in
 * WikiBodyEditor) rather than pinned to the viewport, so it scrolls with
 * the table like a caption.
 */
function TableFloatingMenu({ editor, x, y }: { editor: Editor; x: number; y: number }) {
  function run(fn: (chain: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>) {
    fn(editor.chain().focus()).run();
  }
  return (
    <div
      onMouseDown={(e) => e.preventDefault()}
      style={{ left: x, top: y }}
      className="absolute z-20 flex items-center gap-0.5 rounded-md border border-slate-300 bg-white p-0.5 shadow-md dark:border-slate-700 dark:bg-slate-900"
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
      <TableBtn
        title="Delete table"
        onClick={() => run((c) => c.deleteTable())}
        disabled={!editor.can().deleteTable()}
      >
        <TableIcon className="h-3.5 w-3.5" />
        <Trash2 className="-ml-1 h-3 w-3" />
      </TableBtn>
    </div>
  );
}

function TableBtn({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="inline-flex h-6 items-center gap-0 rounded px-1 text-slate-600 hover:bg-slate-200 disabled:opacity-30 disabled:hover:bg-transparent dark:text-slate-300 dark:hover:bg-slate-700"
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
