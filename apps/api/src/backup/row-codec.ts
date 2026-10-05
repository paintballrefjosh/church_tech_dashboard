import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import type { ColumnMeta, TableMeta } from "./backup-schema";

/**
 * Turning rows into JSON lines and back, and comparing them. A row is read with every
 * timestamp and bigint cast to text (JSON cannot hold a bigint, and a timestamp as text
 * is the same on every run and every engine), and written back with the same casts, so
 * a backup survives a round trip bit for bit.
 */
export type Row = Record<string, unknown>;

const id = (name: string) => sql.identifier(name);

const AS_TEXT = (type: string) => type.startsWith("timestamp") || type === "bigint";

/** `"a", "b"::text AS "b", ...` for the columns asked for. */
export function selectList(table: TableMeta, columns: string[]): SQL {
  const byName = new Map(table.columns.map((c) => [c.name, c]));
  const parts = columns.map((name) => {
    const col = byName.get(name);
    if (!col) throw new Error(`${table.name}.${name} is not a column`);
    return AS_TEXT(col.type) ? sql`${id(name)}::text AS ${id(name)}` : sql`${id(name)}`;
  });
  return sql.join(parts, sql`, `);
}

/** A Postgres array literal for a text[] value. */
export function pgTextArray(values: unknown[]): string {
  const items = values.map((v) => (v === null || v === undefined ? "NULL" : `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`));
  return `{${items.join(",")}}`;
}

/** A value as a typed parameter: `$n::<column type>`. */
export function param(col: ColumnMeta, value: unknown): SQL {
  const type = sql.raw(col.type);
  if (col.type === "jsonb" || col.type === "json") {
    // A JSON null in a NOT NULL jsonb column reads back as JS null, same as SQL NULL: keep it JSON.
    if (value === null || value === undefined) return col.notNull ? sql`'null'::jsonb` : sql`NULL::jsonb`;
    return sql`${JSON.stringify(value)}::${type}`;
  }
  if (value === null || value === undefined) return sql`NULL::${type}`;
  if (col.type.endsWith("[]")) {
    return sql`${pgTextArray(Array.isArray(value) ? value : [value])}::${type}`;
  }
  return sql`${value as string | number | boolean}::${type}`;
}

/** JSON with object keys sorted, so equal values always give equal text. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** A short digest of a row's values in `columns`. */
export function rowFingerprint(row: Row, columns: string[]): string {
  const h = createHash("sha1");
  for (const c of columns) {
    h.update(canonicalJson(row[c]));
    h.update("\u0000");
  }
  return h.digest("base64");
}

/** A row's primary key as one string, stable across runs. */
export function keyOf(row: Row, pk: string[]): string {
  return JSON.stringify(pk.map((c) => (row[c] === null || row[c] === undefined ? null : String(row[c]))));
}

export function keyValues(key: string): Array<string | null> {
  return JSON.parse(key) as Array<string | null>;
}

/** Cut a long value for display. */
export function shorten(value: unknown, max = 160): string | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === "string" ? value : canonicalJson(value);
  return text.length > max ? `${text.slice(0, max)}... (${text.length} characters)` : text;
}

/**
 * A predicate matching rows by primary key: `"id" = ANY(...)` for a one-column key, a list of
 * tuples for a composite one. Keys are as produced by {@link keyOf}.
 */
export function keysPredicate(table: TableMeta, keys: string[]): SQL {
  const byName = new Map(table.columns.map((c) => [c.name, c]));
  const cols = table.pk.map((c) => byName.get(c)!);
  if (cols.length === 1) {
    const col = cols[0]!;
    const values = keys.map((k) => keyValues(k)[0]);
    return sql`${id(col.name)} = ANY(${pgTextArray(values)}::${sql.raw(col.type)}[])`;
  }
  const tuples = keys.map((k) => {
    const v = keyValues(k);
    return sql`(${sql.join(cols.map((c, i) => param(c, v[i])), sql`, `)})`;
  });
  return sql`(${sql.join(cols.map((c) => id(c.name)), sql`, `)}) IN (${sql.join(tuples, sql`, `)})`;
}
