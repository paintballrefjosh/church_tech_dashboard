import type { Node as PMNode } from "@tiptap/pm/model";

/**
 * Markdown serializer for ProseMirror tables, replacing tiptap-markdown's own.
 *
 * tiptap-markdown only writes a GFM pipe table when the first row is all
 * header cells, no other row has one, no cell spans, and every cell holds a
 * single block. Anything else (and that is what Excel and Google Sheets paste:
 * plain cells all the way down, sometimes several paragraphs per cell) falls
 * through to its HTML serializer, which with `html: false` writes the literal
 * text "[table]" and silently destroys the table on save.
 *
 * GFM has no spans and no multi-block cells, so this always writes a pipe table
 * and degrades the rest: the first row is the header whatever its cell type, a
 * cell's blocks are joined with a space (hard breaks become `<br>`-free spaces),
 * and a span only keeps its content in the first column it covers.
 */

/**
 * Per-table settings (column borders, cell background colours) are stored in the
 * page body as an HTML comment on the line above the table. Markdown has no
 * table or cell attributes, and a comment is invisible to every other renderer
 * (and to a person reading the raw text). Form:
 *
 *   <!-- table: borders header pad=8 bg=0.1:#ffd700@40,2.3:#ff0000@100 -->
 *
 * `borders` turns column borders on; `header` styles the first row as a header
 * (tinted, bold); `pad=` is the cell padding in px for the whole table (0 to
 * 32; absent = 5); `bg=` lists `row.column:#rrggbb@opacity%`
 * (zero-based; row 0 is the header). Coordinates are written from the document
 * as it is at save time, so adding or deleting rows and columns just works.
 * The editor folds the comment into table/cell attributes on load and writes it
 * back on save; the page view (remarkTableMeta) turns it into a class and
 * inline styles. Colours are validated strictly: they end up in a style.
 */
export interface CellBg {
  /** `#rrggbb` */
  color: string;
  /** 0 to 100 */
  opacity: number;
}

export interface TableMeta {
  borders: boolean;
  header: boolean;
  /** Cell padding in px, null = default. */
  pad: number | null;
  /** key `row.col` */
  bg: Map<string, CellBg>;
}

const META_RE = /^<!--\s*table:\s*(.*?)\s*-->$/;
export const MAX_TABLE_PAD = 32;
/** Cell padding (px) of a table that sets none; the same value is the CSS fallback in globals.css. */
export const DEFAULT_TABLE_PAD = 5;
const BG_ENTRY_RE = /^(\d{1,4})\.(\d{1,4}):(#[0-9a-fA-F]{6})@(\d{1,3})$/;

/** A cell's `bg` attribute value, `#rrggbb@opacity`; null if it is not one. */
export function parseBgAttr(value: unknown): CellBg | null {
  if (typeof value !== "string") return null;
  const m = /^(#[0-9a-fA-F]{6})@(\d{1,3})$/.exec(value);
  if (!m) return null;
  return { color: m[1]!.toLowerCase(), opacity: Math.min(100, Number(m[2])) };
}

export function formatBgAttr(bg: CellBg): string {
  return `${bg.color.toLowerCase()}@${Math.round(Math.min(100, Math.max(0, bg.opacity)))}`;
}

/** CSS colour for a cell background, e.g. `rgb(255 215 0 / 0.4)`. */
export function cellBackgroundCss(bg: CellBg): string {
  const n = parseInt(bg.color.slice(1), 16);
  const alpha = Math.round(bg.opacity) / 100;
  return `rgb(${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255} / ${alpha})`;
}

/** A table's `pad` attribute as a whole number of px in range, or null. */
export function parsePad(value: unknown): number | null {
  const n = typeof value === "string" && /^\d{1,3}$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= MAX_TABLE_PAD ? n : null;
}

/** The marker comment's content as settings, or null when `text` is not a table marker. */
export function parseTableMeta(text: string): TableMeta | null {
  const m = META_RE.exec(text.trim());
  if (!m) return null;
  const meta: TableMeta = { borders: false, header: false, pad: null, bg: new Map() };
  for (const token of m[1]!.split(/\s+/)) {
    if (token === "borders") meta.borders = true;
    else if (token === "header") meta.header = true;
    else if (token.startsWith("pad=")) meta.pad = parsePad(token.slice(4));
    else if (token.startsWith("bg=")) {
      for (const entry of token.slice(3).split(",")) {
        const e = BG_ENTRY_RE.exec(entry);
        if (e) meta.bg.set(`${e[1]}.${e[2]}`, { color: e[3]!.toLowerCase(), opacity: Math.min(100, Number(e[4])) });
      }
    }
  }
  return meta;
}

/** The marker comment for a table's settings, or null when there is nothing to store. */
export function formatTableMeta(meta: TableMeta): string | null {
  const parts: string[] = [];
  if (meta.borders) parts.push("borders");
  if (meta.header) parts.push("header");
  if (meta.pad !== null) parts.push(`pad=${meta.pad}`);
  if (meta.bg.size) {
    const entries = [...meta.bg.entries()].sort((a, b) => {
      const [ar, ac] = a[0].split(".").map(Number) as [number, number];
      const [br, bc] = b[0].split(".").map(Number) as [number, number];
      return ar - br || ac - bc;
    });
    parts.push(`bg=${entries.map(([k, v]) => `${k}:${formatBgAttr(v)}`).join(",")}`);
  }
  return parts.length ? `<!-- table: ${parts.join(" ")} -->` : null;
}

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hProperties?: Record<string, unknown> };
}

function withProps(node: MdNode, props: Record<string, unknown>): void {
  node.data = { ...node.data, hProperties: { ...node.data?.hProperties, ...props } };
}

/** Inline style for a table with its own cell padding (read by the `.table-pad` rule in globals.css). */
export function tablePadCss(pad: number): string {
  return `--table-cell-pad: ${pad}px`;
}

/** remark plugin: drop each marker, and apply it to the table that follows it (classes, padding, cell colours). */
export function remarkTableMeta() {
  function walk(parent: MdNode): void {
    const kids = parent.children;
    if (!kids) return;
    for (let i = 0; i < kids.length; i++) {
      const n = kids[i]!;
      const meta = n.type === "html" && n.value ? parseTableMeta(n.value) : null;
      if (meta) {
        const next = kids[i + 1];
        if (next?.type === "table") {
          const classes = [
            ...(meta.borders ? ["table-borders"] : []),
            ...(meta.header ? ["table-header"] : []),
            ...(meta.pad !== null ? ["table-pad"] : []),
          ];
          if (classes.length) withProps(next, { className: classes });
          if (meta.pad !== null) withProps(next, { style: tablePadCss(meta.pad) });
          next.children?.forEach((row, r) =>
            row.children?.forEach((cell, c) => {
              const bg = meta.bg.get(`${r}.${c}`);
              if (bg) withProps(cell, { style: `background-color: ${cellBackgroundCss(bg)}` });
            }),
          );
        }
        kids.splice(i, 1);
        i--;
        continue;
      }
      walk(n);
    }
  }
  return (tree: MdNode) => walk(tree);
}

interface SerializerState {
  write(text?: string): void;
  ensureNewLine(): void;
  closeBlock(node: PMNode): void;
  renderInline(node: PMNode): void;
  inTable?: boolean;
  out: string;
}

/** The cell's text as markdown on one line: blocks joined by a space, pipes escaped. */
function cellMarkdown(state: SerializerState, cell: PMNode): string {
  const parts: string[] = [];
  cell.forEach((block) => {
    if (!block.textContent.trim() && block.childCount === 0) return;
    const before = state.out;
    state.out = "";
    try {
      state.renderInline(block);
      parts.push(state.out);
    } finally {
      state.out = before;
    }
  });
  return parts
    .join(" ")
    .replace(/\\?\r?\n+/g, " ")
    .replace(/(?<!\\)\|/g, "\\|")
    .trim();
}

export function serializeTable(state: SerializerState, node: PMNode): void {
  // Emit the blank line owed to the previous block (and any list/quote prefix)
  // BEFORE cells are rendered into their scratch buffers: renderInline's first
  // write() would otherwise spend it there, where it is thrown away, and the
  // table would be glued onto the end of the paragraph above it.
  const meta: TableMeta = {
    borders: node.attrs.borders === true,
    header: node.attrs.header === true,
    pad: parsePad(node.attrs.pad),
    bg: new Map(),
  };
  const rows: string[][] = [];
  node.forEach((row, _o, r) => {
    const cells: string[] = [];
    row.forEach((cell, _co, c) => {
      const bg = parseBgAttr(cell.attrs.bg);
      if (bg && bg.opacity > 0) meta.bg.set(`${r}.${c}`, bg);
      cells.push("");
    });
    rows.push(cells);
  });
  const marker = formatTableMeta(meta);
  state.write(marker ?? "");
  if (marker) {
    state.closeBlock(node);
    state.write();
  }
  node.forEach((row, _o, r) => {
    row.forEach((cell, _co, c) => {
      rows[r]![c] = cellMarkdown(state, cell);
    });
  });
  const width = Math.max(1, ...rows.map((r) => r.length));

  state.inTable = true;
  rows.forEach((cells, i) => {
    const padded = [...cells, ...Array<string>(width - cells.length).fill("")];
    state.write(`| ${padded.join(" | ")} |`);
    state.ensureNewLine();
    if (i === 0) {
      state.write(`| ${Array<string>(width).fill("---").join(" | ")} |`);
      state.ensureNewLine();
    }
  });
  state.closeBlock(node);
  state.inTable = false;
}

/**
 * Editor load: with raw HTML off, a marker comment arrives as a paragraph of
 * text. Fold each into the table after it (`data-borders`, `data-header`,
 * `data-pad`, `data-bg` on cells,
 * read back by the table extensions' parseHTML) and remove the paragraph.
 */
export function applyTableMetaToDom(root: HTMLElement): void {
  root.querySelectorAll("p").forEach((p) => {
    const meta = parseTableMeta(p.textContent ?? "");
    if (!meta) return;
    const next = p.nextElementSibling;
    if (next?.tagName === "TABLE") {
      if (meta.borders) next.setAttribute("data-borders", "true");
      if (meta.header) next.setAttribute("data-header", "true");
      if (meta.pad !== null) next.setAttribute("data-pad", String(meta.pad));
      next.querySelectorAll("tr").forEach((tr, r) =>
        Array.from(tr.children).forEach((cell, c) => {
          const bg = meta.bg.get(`${r}.${c}`);
          if (bg) cell.setAttribute("data-bg", formatBgAttr(bg));
        }),
      );
    }
    p.remove();
  });
}
