import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { Node as PMNode } from "@tiptap/pm/model";
import { getSchema } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TableExt from "@tiptap/extension-table";
import TableRowExt from "@tiptap/extension-table-row";
import TableHeaderExt from "@tiptap/extension-table-header";
import TableCellExt from "@tiptap/extension-table-cell";
import { remarkTableBorders, serializeTable, TABLE_BORDERS_MARKER } from "./wiki-table-markdown";

const BorderedTable = TableExt.extend({
  addAttributes() {
    return { ...this.parent?.(), borders: { default: false } };
  },
});
const schema = getSchema([StarterKit, BorderedTable, TableRowExt, TableHeaderExt, TableCellExt]);

function cell(type: "tableCell" | "tableHeader", ...paras: string[]) {
  return schema.nodes[type]!.create(
    null,
    paras.map((t) => schema.nodes.paragraph!.create(null, t ? schema.text(t) : undefined)),
  );
}
function row(...cells: ReturnType<typeof cell>[]) {
  return schema.nodes.tableRow!.create(null, cells);
}

// prosemirror-markdown's real serializer state (a dependency of tiptap-markdown, so
// resolved from there): a fake would not reproduce the blank-line bookkeeping.
const req = createRequire(createRequire(import.meta.url).resolve("tiptap-markdown"));
const { MarkdownSerializer } = req("prosemirror-markdown") as {
  MarkdownSerializer: new (
    nodes: Record<string, (state: never, node: PMNode, parent: PMNode, index: number) => void>,
    marks: Record<string, unknown>,
  ) => { serialize(doc: PMNode, opts?: object): string };
};

const serializer = new MarkdownSerializer(
  {
    doc: (state: never, node: PMNode) => (state as { renderContent(n: PMNode): void }).renderContent(node),
    paragraph: (state: never, node: PMNode) => {
      const s = state as { renderInline(n: PMNode): void; closeBlock(n: PMNode): void };
      s.renderInline(node);
      s.closeBlock(node);
    },
    text: (state: never, node: PMNode) => (state as { text(t: string): void }).text(node.text ?? ""),
    table: serializeTable as never,
  },
  {},
);

function para(text: string) {
  return schema.nodes.paragraph!.create(null, schema.text(text));
}
function run(...blocks: PMNode[]): string {
  return serializer.serialize(schema.nodes.doc!.create(null, blocks));
}

describe("serializeTable", () => {
  it("writes an Excel-shaped table (plain cells, no header row) as a pipe table, not [table]", () => {
    const t = schema.nodes.table!.create(null, [
      row(cell("tableCell", "Name"), cell("tableCell", "Role")),
      row(cell("tableCell", "Ann"), cell("tableCell", "Sound")),
    ]);
    expect(run(t)).toBe("| Name | Role |\n| --- | --- |\n| Ann | Sound |\n");
  });

  it("joins multi-paragraph cells, escapes pipes and pads ragged rows", () => {
    const t = schema.nodes.table!.create(null, [
      row(cell("tableHeader", "A"), cell("tableHeader", "B"), cell("tableHeader", "C")),
      row(cell("tableCell", "one", "two"), cell("tableCell", "x|y")),
      row(cell("tableCell", ""), cell("tableCell", "")),
    ]);
    expect(run(t)).toBe(
      "| A | B | C |\n| --- | --- | --- |\n| one two | x\\|y |  |\n|  |  |  |\n",
    );
  });

  it("keeps a table off the paragraph above it and apart from the next table", () => {
    const t1 = schema.nodes.table!.create(null, [
      row(cell("tableCell", "Panel LA2"), cell("tableCell", "")),
      row(cell("tableCell", "43"), cell("tableCell", "Cloud")),
    ]);
    const t2 = schema.nodes.table!.create(null, [
      row(cell("tableCell", "Panel LA3"), cell("tableCell", "")),
      row(cell("tableCell", "92"), cell("tableCell", "Wall")),
    ]);
    expect(run(para("Below are the breakers."), t1, t2, para("After."))).toBe(
      [
        "Below are the breakers.",
        "",
        "| Panel LA2 |  |",
        "| --- | --- |",
        "| 43 | Cloud |",
        "",
        "| Panel LA3 |  |",
        "| --- | --- |",
        "| 92 | Wall |",
        "",
        "After.",
      ].join("\n"),
    );
  });

  it("writes the borders marker above only the tables that have it on", () => {
    const mk = (borders: boolean, name: string) =>
      schema.nodes.table!.create({ borders }, [
        row(cell("tableCell", name), cell("tableCell", "")),
        row(cell("tableCell", "1"), cell("tableCell", "2")),
      ]);
    expect(run(para("Intro."), mk(true, "A"), mk(false, "B"))).toBe(
      [
        "Intro.",
        "",
        TABLE_BORDERS_MARKER,
        "",
        "| A |  |",
        "| --- | --- |",
        "| 1 | 2 |",
        "",
        "| B |  |",
        "| --- | --- |",
        "| 1 | 2 |",
        "",
      ].join("\n"),
    );
  });
});

describe("remarkTableBorders", () => {
  it("removes the marker and tags the table after it, leaving other tables alone", () => {
    const table = () => ({ type: "table", children: [] });
    const tree = {
      type: "root",
      children: [
        { type: "paragraph", children: [] },
        { type: "html", value: TABLE_BORDERS_MARKER },
        table(),
        table(),
        { type: "html", value: "<!-- something else -->" },
      ],
    };
    remarkTableBorders()(tree);
    expect(tree.children.map((c) => c.type)).toEqual(["paragraph", "table", "table", "html"]);
    expect((tree.children[1] as { data?: unknown }).data).toEqual({
      hProperties: { className: ["table-borders"] },
    });
    expect((tree.children[2] as { data?: unknown }).data).toBeUndefined();
  });
});
