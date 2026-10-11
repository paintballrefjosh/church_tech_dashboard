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
 * Per-table "column borders" is stored in the page body as an HTML comment on
 * the line above the table. Markdown has no table attributes, and a comment is
 * invisible to every other renderer (and to a person reading the raw text).
 * The editor strips it on load into a `borders` attribute and writes it back on
 * save; the page view (remarkTableBorders) turns it into a class on the table.
 */
export const TABLE_BORDERS_MARKER = "<!-- table: borders -->";

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hProperties?: Record<string, unknown> };
}

/** remark plugin: drop each marker and tag the table that follows it with `table-borders`. */
export function remarkTableBorders() {
  function walk(parent: MdNode): void {
    const kids = parent.children;
    if (!kids) return;
    for (let i = 0; i < kids.length; i++) {
      const n = kids[i]!;
      if (n.type === "html" && n.value?.trim() === TABLE_BORDERS_MARKER) {
        const next = kids[i + 1];
        if (next?.type === "table") {
          next.data = {
            ...next.data,
            hProperties: { ...next.data?.hProperties, className: ["table-borders"] },
          };
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
  state.write(node.attrs.borders ? TABLE_BORDERS_MARKER : "");
  if (node.attrs.borders) {
    state.closeBlock(node);
    state.write();
  }
  const rows: string[][] = [];
  node.forEach((row) => {
    const cells: string[] = [];
    row.forEach((cell) => {
      cells.push(cellMarkdown(state, cell));
    });
    rows.push(cells);
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
