import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "../db/schema";
import { TABLE_REGISTRY, isBackedUp } from "./table-registry";

/**
 * What a backup knows about the schema, read from the Drizzle table definitions so there
 * is no second list of columns to keep in step. Types are the SQL types Drizzle emits
 * (`uuid`, `text`, `timestamp with time zone`, `text[]`, ...); this schema uses no enums.
 */
export interface ColumnMeta {
  name: string;
  /** SQL type, usable in a cast. */
  type: string;
  notNull: boolean;
  /** The database fills it in when an insert leaves it out. */
  hasDefault: boolean;
}

export interface TableMeta {
  name: string;
  columns: ColumnMeta[];
  pk: string[];
  /** Tables this one has a foreign key to (not counting itself). */
  parents: string[];
  /** Foreign keys from this table to itself (a folder's parent folder). */
  selfRefs: Array<{ column: string; refColumn: string }>;
}

let cached: TableMeta[] | null = null;

/** Every table in the schema, alphabetical. */
export function allTables(): TableMeta[] {
  if (cached) return cached;
  const tables = Object.values(schema).filter((v) => is(v, PgTable)) as unknown as PgTable[];
  const metas = tables.map((t): TableMeta => {
    const cfg = getTableConfig(t);
    const columns = cfg.columns.map((c) => ({
      name: c.name,
      type: c.getSQLType(),
      notNull: c.notNull,
      hasDefault: c.hasDefault,
    }));
    const pk = [
      ...cfg.columns.filter((c) => c.primary).map((c) => c.name),
      ...cfg.primaryKeys.flatMap((p) => p.columns.map((c) => c.name)),
    ];
    const parents = new Set<string>();
    const selfRefs: TableMeta["selfRefs"] = [];
    for (const fk of cfg.foreignKeys) {
      const ref = fk.reference();
      const target = getTableConfig(ref.foreignTable).name;
      if (target === cfg.name) {
        ref.columns.forEach((c, i) => selfRefs.push({ column: c.name, refColumn: ref.foreignColumns[i]!.name }));
      } else {
        parents.add(target);
      }
    }
    return { name: cfg.name, columns, pk, parents: [...parents].sort(), selfRefs };
  });
  cached = metas.sort((a, b) => a.name.localeCompare(b.name));
  return cached;
}

export function tableMeta(name: string): TableMeta | undefined {
  return allTables().find((t) => t.name === name);
}

/**
 * Tables a backup saves, parents before children, so rows can be inserted in this order and
 * deleted in the reverse without a foreign key getting in the way. Ties break alphabetically
 * so the order is the same on every run.
 */
export function backedUpTables(): TableMeta[] {
  const wanted = allTables().filter((t) => isBackedUp(t.name));
  const names = new Set(wanted.map((t) => t.name));
  const done = new Set<string>();
  const out: TableMeta[] = [];
  const pending = [...wanted];
  while (pending.length > 0) {
    const ready = pending.filter((t) => t.parents.filter((p) => names.has(p)).every((p) => done.has(p)));
    if (ready.length === 0) {
      throw new Error(`foreign key cycle between backed-up tables: ${pending.map((t) => t.name).join(", ")}`);
    }
    ready.sort((a, b) => a.name.localeCompare(b.name));
    const next = ready[0]!;
    out.push(next);
    done.add(next.name);
    pending.splice(pending.indexOf(next), 1);
  }
  return out;
}

/** Registry entries that name no table (a table was renamed or removed). */
export function unknownRegistryEntries(): string[] {
  const known = new Set(allTables().map((t) => t.name));
  return Object.keys(TABLE_REGISTRY).filter((n) => !known.has(n));
}

/** Tables with no registry entry (a table was added without deciding what a backup does with it). */
export function unclassifiedTables(): string[] {
  return allTables().map((t) => t.name).filter((n) => !(n in TABLE_REGISTRY));
}
