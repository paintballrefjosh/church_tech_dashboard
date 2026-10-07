import { describe, expect, it } from "vitest";
import { allTables, backedUpTables, tableMeta } from "../src/backup/backup-schema";
import { TABLE_REGISTRY, restoreSections, sectionKey, sectionTitle, tablesInSections } from "../src/backup/table-registry";
import { parentKeyOf, skipThroughSelfReference } from "../src/backup/backup-scope";

describe("restore sections", () => {
  const sections = restoreSections();

  it("cover every table a backup saves, each in exactly one section (a table in none could never be restored on its own)", () => {
    const sectionTitles = new Set(sections.map((s) => s.title));
    for (const t of backedUpTables()) {
      const info = TABLE_REGISTRY[t.name]!;
      expect(sectionTitles.has(info.group), `${t.name} is in the group "${info.group}", which is not a restore section (add it to SECTION_ORDER in table-registry.ts)`).toBe(true);
    }
    const listed = sections.flatMap((s) => s.tables);
    const saved = backedUpTables().map((t) => TABLE_REGISTRY[t.name]!.title);
    expect(listed.sort()).toEqual(saved.sort());
  });

  it("have unique keys, a description and a list of what is in them, and only Files holds files", () => {
    expect(new Set(sections.map((s) => s.key)).size).toBe(sections.length);
    for (const s of sections) {
      expect(s.description, s.title).not.toBe("");
      expect(s.tables.length, s.title).toBeGreaterThan(0);
    }
    expect(sections.filter((s) => s.hasFiles).map((s) => s.title)).toEqual(["Files"]);
  });

  it("use the same keys the comparison report uses for its groups", () => {
    expect(sections.map((s) => s.key)).toContain("people-and-access");
    expect(sectionKey("Network and devices")).toBe("network-and-devices");
    expect(sectionTitle("wiki")).toBe("Wiki");
    expect(sectionTitle("nonsense")).toBeUndefined();
  });

  it("name the tables of the chosen sections, and every table when all are chosen", () => {
    expect([...tablesInSections(["wiki"])].sort()).toEqual(["wiki_folders", "wiki_page_acl", "wiki_pages", "wiki_revisions"]);
    expect(tablesInSections(["nonsense"]).size).toBe(0);
    expect([...tablesInSections(sections.map((s) => s.key))].sort()).toEqual(backedUpTables().map((t) => t.name).sort());
  });

  it("never include a table a backup does not save", () => {
    for (const t of tablesInSections(sections.map((s) => s.key))) expect(TABLE_REGISTRY[t]!.policy).toBe("data");
  });
});

describe("foreign keys, as a partial restore follows them", () => {
  it("every foreign key of a saved table points at its parent's whole primary key (otherwise a partial restore cannot check it)", () => {
    const bad: string[] = [];
    for (const t of backedUpTables()) {
      for (const fk of t.foreignKeys) {
        const parent = tableMeta(fk.parent);
        if (!parent) continue;
        if (fk.parentColumns.length !== parent.pk.length || !fk.parentColumns.every((c, i) => c === parent.pk[i])) {
          bad.push(`${t.name}(${fk.columns.join(",")}) -> ${fk.parent}(${fk.parentColumns.join(",")})`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("reads the key a row's foreign key points at, and nothing when the column is empty", () => {
    const pages = tableMeta("wiki_pages")!;
    const users = tableMeta("users")!;
    const fk = pages.foreignKeys.find((f) => f.parent === "users")!;
    expect(fk.columns).toEqual(["owner_user_id"]);
    expect(parentKeyOf({ owner_user_id: "u-1" }, fk, users)).toBe(JSON.stringify(["u-1"]));
    expect(parentKeyOf({ owner_user_id: null }, fk, users)).toBeNull();
    expect(parentKeyOf({}, fk, users)).toBeNull();
  });

  it("knows which tables refer to which across the whole schema (sanity: users are referenced by many)", () => {
    const referencing = allTables().filter((t) => t.foreignKeys.some((fk) => fk.parent === "users"));
    expect(referencing.length).toBeGreaterThan(10);
  });
});

describe("skipping through a self reference", () => {
  it("skips a row whose parent row is skipped, and the rows under that, but not siblings", () => {
    const parents = new Map<string, string[]>([
      ["a", []],
      ["b", ["a"]],
      ["c", ["b"]],
      ["d", ["x"]], // x is not skipped (it exists)
    ]);
    const skipped = new Set(["a"]);
    skipThroughSelfReference(parents, skipped);
    expect([...skipped].sort()).toEqual(["a", "b", "c"]);
  });

  it("terminates on rows that point at each other", () => {
    const parents = new Map<string, string[]>([
      ["p", ["q"]],
      ["q", ["p"]],
    ]);
    const skipped = new Set(["p"]);
    skipThroughSelfReference(parents, skipped);
    expect([...skipped].sort()).toEqual(["p", "q"]);
  });

  it("does nothing when nothing is skipped", () => {
    const skipped = new Set<string>();
    skipThroughSelfReference(new Map([["a", ["b"]]]), skipped);
    expect(skipped.size).toBe(0);
  });
  it("the Monitoring section holds everything under the Monitoring menu, and printers are their own section", () => {
    const monitoring = restoreSections().find((x) => x.key === "monitoring");
    expect(monitoring?.tables).toEqual(expect.arrayContaining(["Service monitors", "Infrastructure hosts", "Cisco switches", "Cisco ports", "IPAM subnets", "UPS devices"]));
    expect(restoreSections().find((x) => x.key === "printers")?.tables).toEqual(["Printers"]);
    expect(restoreSections().some((x) => x.key.includes("devices"))).toBe(false);
  });
});
