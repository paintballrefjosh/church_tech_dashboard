import { sql, type SQL } from "drizzle-orm";
import type { BackupProgress } from "@church/shared";
import type { Db } from "../db/db.module";
import { backedUpTables, tableMeta, type TableMeta } from "./backup-schema";
import { TABLE_REGISTRY, tableInfo } from "./table-registry";
import { keyOf, keysPredicate, param, type Row } from "./row-codec";
import { readArchive } from "./archive";
import type { DiffContext, DiffOutput, TablePlan } from "./backup-diff";

const id = (name: string) => sql.identifier(name);

/** Largest batch of rows (by JSON size) or count in one INSERT, and keys in one DELETE. */
const BATCH_ROWS = 200;
const BATCH_BYTES = 1024 * 1024;
const DELETE_KEYS = 500;

/**
 * Put rows whose parent is another row of the same table (a folder's parent folder) after that
 * parent. Rows that point at each other in a cycle, or at themselves, are returned in `loose`:
 * they are inserted with that column empty and fixed up afterwards.
 */
export function orderBySelfReference(
  table: TableMeta,
  rows: Row[],
): { ordered: Row[]; loose: Array<{ row: Row; columns: string[] }> } {
  if (table.selfRefs.length === 0) return { ordered: rows, loose: [] };
  const byRef = new Map<string, Row>();
  for (const ref of table.selfRefs) {
    for (const r of rows) byRef.set(`${ref.refColumn}\u0000${String(r[ref.refColumn])}`, r);
  }
  const parentsOf = (r: Row): Row[] => {
    const out: Row[] = [];
    for (const ref of table.selfRefs) {
      const v = r[ref.column];
      if (v === null || v === undefined) continue;
      const parent = byRef.get(`${ref.refColumn}\u0000${String(v)}`);
      if (parent && parent !== r) out.push(parent);
    }
    return out;
  };
  const placed = new Set<Row>();
  const ordered: Row[] = [];
  let remaining = rows.slice();
  for (;;) {
    const ready = remaining.filter((r) => parentsOf(r).every((p) => placed.has(p)));
    if (ready.length === 0) break;
    for (const r of ready) {
      placed.add(r);
      ordered.push(r);
    }
    remaining = remaining.filter((r) => !placed.has(r));
  }
  const loose = remaining.map((row) => ({ row, columns: table.selfRefs.map((r) => r.column) }));
  return { ordered, loose };
}

/** `INSERT` for rows the plan says are missing. No `ON CONFLICT`: that clause makes the database read every row first and is about 13 times slower (measured on CockroachDB 24.2). */
function insertStatement(table: TableMeta, columns: string[], rows: Row[]): SQL {
  const byName = new Map(table.columns.map((c) => [c.name, c]));
  const tuples = rows.map((r) => sql`(${sql.join(columns.map((c) => param(byName.get(c)!, r[c])), sql`, `)})`);
  return sql`INSERT INTO ${id(table.name)} (${sql.join(columns.map((c) => id(c)), sql`, `)}) VALUES ${sql.join(tuples, sql`, `)}`;
}

/** One `UPDATE` for a batch of rows the plan says exist but differ: join the table to a list of the new values. */
function updateStatement(table: TableMeta, writable: string[], rows: Row[]): SQL {
  const byName = new Map(table.columns.map((c) => [c.name, c]));
  const columns = [...table.pk, ...writable];
  const tuples = rows.map((r) => sql`(${sql.join(columns.map((c) => param(byName.get(c)!, r[c])), sql`, `)})`);
  const set = sql.join(writable.map((c) => sql`${id(c)} = v.${id(c)}`), sql`, `);
  const match = sql.join(table.pk.map((c) => sql`${id(table.name)}.${id(c)} = v.${id(c)}`), sql` AND `);
  return sql`UPDATE ${id(table.name)} SET ${set} FROM (VALUES ${sql.join(tuples, sql`, `)}) AS v (${sql.join(columns.map((c) => id(c)), sql`, `)}) WHERE ${match}`;
}

export interface RestoreCounts {
  rowsAdded: number;
  rowsRemoved: number;
  rowsChanged: number;
}

/**
 * Make the database match the backup, in one transaction: delete the rows that are not in it
 * (children first), then insert the missing ones and update the changed ones (parents first).
 * Anything that fails, a constraint included, rolls the lot back and leaves the database as it was.
 *
 * `plans` is what {@link computeDiff} worked out; it is followed, not recomputed, so the
 * report a person read is what is applied. The caller holds the restore gate, so nothing else
 * writes meanwhile: a row the plan calls missing really is, and a plain INSERT of it is safe.
 */
export async function applyRestore(
  deps: { db: Db; progress?: (p: BackupProgress) => void | Promise<void> },
  diff: DiffOutput,
  ctx: Pick<DiffContext, "archive">,
): Promise<RestoreCounts> {
  // If a statement fails, the driver rolls back, and a failing rollback replaces the error a person
  // needs to see. Keep the first one and report that.
  let original: unknown = null;
  try {
    await deps.db.transaction(async (tx) => {
      try {
        await applyInTransaction(tx, deps.progress, diff, ctx);
      } catch (err) {
        original = err;
        throw err;
      }
    });
  } catch (err) {
    throw original ?? err;
  }

  let rowsAdded = 0;
  let rowsRemoved = 0;
  let rowsChanged = 0;
  for (const plan of diff.plans.values()) {
    rowsAdded += plan.addedKeys.length;
    rowsRemoved += plan.removedKeys.length;
    rowsChanged += plan.changedKeys.length;
  }
  return { rowsAdded, rowsRemoved, rowsChanged };
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** One table being restored: which keys to insert and which to update, and the rows waiting to be written. */
interface OpenTable {
  table: TableMeta;
  plan: TablePlan;
  added: Set<string>;
  changed: Set<string>;
  writable: string[];
  /** Rows to insert / update, held back until the table ends when its own order matters (self references). */
  heldAdded: Row[];
  heldChanged: Row[];
  batchAdded: Row[];
  batchChanged: Row[];
  bytesAdded: number;
  bytesChanged: number;
}

async function applyInTransaction(
  tx: Tx,
  progress: ((p: BackupProgress) => void | Promise<void>) | undefined,
  diff: DiffOutput,
  ctx: Pick<DiffContext, "archive">,
): Promise<void> {
  const { plans } = diff;
  // A restore limited to some sections has plans for those tables only; the rest is not touched.
  const order = backedUpTables().filter((t) => plans.has(t.name));
  await tx.execute(sql`SELECT set_config('TimeZone', 'UTC', true)`);

  // ---- deletes: children before parents ----
  const reversed = [...order].reverse();
  for (const [i, table] of reversed.entries()) {
    const plan = plans.get(table.name);
    if (!plan) continue;
    await progress?.({ label: `Removing rows added since: ${tableInfo(table.name).title.toLowerCase()}`, done: i, total: reversed.length });
    if (plan.deleteAll) {
      await tx.execute(sql`DELETE FROM ${id(table.name)}`);
    } else {
      for (let k = 0; k < plan.removedKeys.length; k += DELETE_KEYS) {
        await tx.execute(sql`DELETE FROM ${id(table.name)} WHERE ${keysPredicate(table, plan.removedKeys.slice(k, k + DELETE_KEYS))}`);
      }
    }
  }

  // ---- inserts and updates: parents before children, straight from the archive ----
  let open: OpenTable | null = null;
  let done = 0;

  const flushAdded = async (o: OpenTable) => {
    if (o.batchAdded.length === 0) return;
    await tx.execute(insertStatement(o.table, o.plan.columns, o.batchAdded));
    o.batchAdded = [];
    o.bytesAdded = 0;
  };
  const flushChanged = async (o: OpenTable) => {
    if (o.batchChanged.length === 0) return;
    await tx.execute(updateStatement(o.table, o.writable, o.batchChanged));
    o.batchChanged = [];
    o.bytesChanged = 0;
  };

  /** Write a table's held rows: inserts in an order where every row's parent is already there, then updates. */
  const writeHeld = async (o: OpenTable) => {
    const selfCols = new Set(o.table.selfRefs.map((r) => r.column));
    const { ordered, loose } = orderBySelfReference(o.table, o.heldAdded);
    const looseSet = new Set(loose.map((l) => l.row));
    // Rows that point at each other are inserted with those pointers empty and filled in below.
    const inserts = [
      ...ordered.filter((r) => !looseSet.has(r)),
      ...loose.map(({ row }) => {
        const copy: Row = { ...row };
        for (const c of selfCols) copy[c] = null;
        return copy;
      }),
    ];
    for (let k = 0; k < inserts.length; k += BATCH_ROWS) {
      await tx.execute(insertStatement(o.table, o.plan.columns, inserts.slice(k, k + BATCH_ROWS)));
    }
    const byName = new Map(o.table.columns.map((c) => [c.name, c]));
    for (const { row } of loose) {
      const sets = [...selfCols].filter((c) => o.plan.columns.includes(c));
      if (sets.length === 0) continue;
      await tx.execute(
        sql`UPDATE ${id(o.table.name)} SET ${sql.join(sets.map((c) => sql`${id(c)} = ${param(byName.get(c)!, row[c])}`), sql`, `)} WHERE ${keysPredicate(o.table, [keyOf(row, o.table.pk)])}`,
      );
    }
    for (let k = 0; k < o.heldChanged.length; k += BATCH_ROWS) {
      await tx.execute(updateStatement(o.table, o.writable, o.heldChanged.slice(k, k + BATCH_ROWS)));
    }
  };

  for await (const event of readArchive(ctx.archive())) {
    if (event.type === "tableStart") {
      const plan = plans.get(event.table);
      const table = tableMeta(event.table);
      if (plan && table && plan.addedKeys.length + plan.changedKeys.length > 0) {
        const volatile = new Set(tableInfo(event.table).volatile ?? []);
        open = {
          table,
          plan,
          added: new Set(plan.addedKeys),
          changed: new Set(plan.changedKeys),
          writable: plan.columns.filter((c) => !table.pk.includes(c) && !volatile.has(c)),
          heldAdded: [],
          heldChanged: [],
          batchAdded: [],
          batchChanged: [],
          bytesAdded: 0,
          bytesChanged: 0,
        };
      }
    } else if (event.type === "rows" && open) {
      const o = open;
      for (const row of event.rows) {
        const key = keyOf(row, o.table.pk);
        const isAdded = o.added.has(key);
        if (!isAdded && !o.changed.has(key)) continue;
        if (o.table.selfRefs.length > 0) {
          (isAdded ? o.heldAdded : o.heldChanged).push(row);
        } else if (isAdded) {
          o.batchAdded.push(row);
          o.bytesAdded += JSON.stringify(row).length;
          if (o.batchAdded.length >= BATCH_ROWS || o.bytesAdded >= BATCH_BYTES) await flushAdded(o);
        } else {
          o.batchChanged.push(row);
          o.bytesChanged += JSON.stringify(row).length;
          if (o.batchChanged.length >= BATCH_ROWS || o.bytesChanged >= BATCH_BYTES) await flushChanged(o);
        }
      }
    } else if (event.type === "tableEnd" && open) {
      const o = open;
      open = null;
      await progress?.({ label: `Restoring ${tableInfo(o.table.name).title.toLowerCase()}`, done: done++, total: order.length });
      if (o.table.selfRefs.length > 0) {
        await writeHeld(o);
      } else {
        await flushAdded(o); // inserts before updates, so an updated row's parent is already there
        await flushChanged(o);
      }
    } else if (event.type === "files" || event.type === "file" || event.type === "summary") {
      break;
    }
  }

  // ---- sequences: move them past the restored values ----
  for (const table of order) {
    for (const seq of TABLE_REGISTRY[table.name]?.sequences ?? []) {
      // Never backwards: GREATEST with where the sequence already is.
      await tx.execute(
        sql`SELECT setval(${seq.sequence}::regclass, GREATEST((SELECT coalesce(max(${id(seq.column)}), 1) FROM ${id(table.name)}), (SELECT last_value FROM ${id(seq.sequence)}), 1))`,
      );
    }
  }
}
