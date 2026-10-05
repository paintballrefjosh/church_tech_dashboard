import { describe, expect, it } from "vitest";
import { allTables, backedUpTables, unclassifiedTables, unknownRegistryEntries } from "../src/backup/backup-schema";
import { TABLE_REGISTRY, isBackedUp } from "../src/backup/table-registry";
import { canonicalJson, keyOf, keyValues, pgTextArray, rowFingerprint } from "../src/backup/row-codec";
import { orderBySelfReference } from "../src/backup/backup-restore";

describe("backup table registry", () => {
  it("has a decision for every table (a new table must be classified in table-registry.ts)", () => {
    expect(unclassifiedTables()).toEqual([]);
  });

  it("has no entry for a table that no longer exists", () => {
    expect(unknownRegistryEntries()).toEqual([]);
  });

  it("gives every skipped table a reason", () => {
    for (const [name, info] of Object.entries(TABLE_REGISTRY)) {
      if (info.policy === "skip") expect(info.reason, `${name} needs a reason`).toBeTruthy();
    }
  });

  it("only names columns that exist", () => {
    for (const t of allTables()) {
      const info = TABLE_REGISTRY[t.name]!;
      const cols = new Set(t.columns.map((c) => c.name));
      for (const list of [info.label, info.volatile, info.sensitive]) {
        for (const c of list ?? []) expect(cols.has(c), `${t.name}.${c}`).toBe(true);
      }
    }
  });

  it("every backed-up table has a primary key and the key columns are never volatile", () => {
    for (const t of backedUpTables()) {
      expect(t.pk.length, `${t.name} has no primary key`).toBeGreaterThan(0);
      for (const c of t.pk) expect(TABLE_REGISTRY[t.name]!.volatile ?? []).not.toContain(c);
    }
  });

  it("never lets a backed-up table depend on one that is skipped (a restore could break a foreign key)", () => {
    for (const t of backedUpTables()) {
      for (const p of t.parents) {
        expect(isBackedUp(p), `${t.name} has a foreign key to ${p}, which a backup skips`).toBe(true);
      }
    }
  });

  it("orders tables so that parents come before the tables that refer to them", () => {
    const order = backedUpTables().map((t) => t.name);
    expect(new Set(order).size).toBe(order.length);
    for (const t of backedUpTables()) {
      for (const p of t.parents) expect(order.indexOf(p), `${p} before ${t.name}`).toBeLessThan(order.indexOf(t.name));
    }
  });

  it("does not back up the backup tables themselves, the audit log or per-node state", () => {
    for (const name of ["backups", "backup_schedules", "backup_operations", "audit_log", "cluster_leases", "cluster_nodes", "realtime_events", "mail_outbox", "job_state"]) {
      expect(isBackedUp(name), name).toBe(false);
    }
    for (const name of ["users", "settings", "tickets", "wiki_pages", "attachments", "groups"]) {
      expect(isBackedUp(name), name).toBe(true);
    }
  });

  it("types are ones the codec knows how to write back", () => {
    const known = /^(uuid|text|integer|boolean|real|bigint|jsonb|text\[\]|timestamp( with time zone)?)$/;
    for (const t of backedUpTables()) {
      for (const c of t.columns) expect(c.type, `${t.name}.${c.name}`).toMatch(known);
    }
  });
});

describe("row codec", () => {
  it("canonicalJson ignores key order and treats undefined as null", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
    expect(canonicalJson(undefined)).toBe("null");
    expect(canonicalJson("x")).toBe('"x"');
  });

  it("fingerprints equal values equally and different values differently", () => {
    const a = { id: "1", n: 5, j: { x: 1, y: [1, 2] } };
    const b = { j: { y: [1, 2], x: 1 }, n: 5, id: "1" };
    expect(rowFingerprint(a, ["id", "n", "j"])).toBe(rowFingerprint(b, ["id", "n", "j"]));
    expect(rowFingerprint(a, ["id", "n", "j"])).not.toBe(rowFingerprint({ ...a, n: 6 }, ["id", "n", "j"]));
    // Only the columns asked for count.
    expect(rowFingerprint(a, ["id"])).toBe(rowFingerprint({ ...a, n: 99 }, ["id"]));
  });

  it("builds keys that round-trip, with a composite key in column order", () => {
    const key = keyOf({ group_id: "g", user_id: "u", x: 1 }, ["group_id", "user_id"]);
    expect(keyValues(key)).toEqual(["g", "u"]);
    expect(keyOf({ id: 12 }, ["id"])).toBe('["12"]');
  });

  it("writes text arrays safely", () => {
    expect(pgTextArray(["a", 'b"c', "d\\e", null])).toBe('{"a","b\\"c","d\\\\e",NULL}');
    expect(pgTextArray([])).toBe("{}");
  });
});

describe("self-referencing tables", () => {
  const folders = allTables().find((t) => t.name === "wiki_folders")!;

  it("puts a parent before its children whatever order they arrive in", () => {
    const rows = [
      { id: "c", parent_folder_id: "b" },
      { id: "b", parent_folder_id: "a" },
      { id: "a", parent_folder_id: null },
      { id: "x", parent_folder_id: "outside" },
    ];
    const { ordered, loose } = orderBySelfReference(folders, rows);
    expect(loose).toEqual([]);
    const pos = (id: string) => ordered.findIndex((r) => r.id === id);
    expect(pos("a")).toBeLessThan(pos("b"));
    expect(pos("b")).toBeLessThan(pos("c"));
    expect(ordered).toHaveLength(4);
  });

  it("hands back rows that point at each other, to be filled in afterwards", () => {
    const rows = [
      { id: "a", parent_folder_id: "b" },
      { id: "b", parent_folder_id: "a" },
      { id: "c", parent_folder_id: null },
    ];
    const { ordered, loose } = orderBySelfReference(folders, rows);
    expect(ordered.map((r) => r.id)).toEqual(["c"]);
    expect(loose.map((l) => l.row.id).sort()).toEqual(["a", "b"]);
  });

  it("leaves a table without a self reference alone", () => {
    const tickets = allTables().find((t) => t.name === "tickets")!;
    const rows = [{ id: "1" }, { id: "2" }];
    expect(orderBySelfReference(tickets, rows)).toEqual({ ordered: rows, loose: [] });
  });
});
