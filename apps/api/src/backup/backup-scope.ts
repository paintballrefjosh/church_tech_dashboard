import { sql } from "drizzle-orm";
import type { Db } from "../db/db.module";
import { backedUpTables, tableMeta, type ForeignKeyMeta, type TableMeta } from "./backup-schema";
import { readArchive } from "./archive";
import { keyOf, keyValues, keysPredicate, param, selectList, type Row } from "./row-codec";

/**
 * A restore limited to some sections (wiki, notes, users ...) must not break what it leaves alone,
 * and must not be broken by it. Tables are linked by foreign keys, so at the edge of the chosen
 * sections two things can go wrong, and each has one rule:
 *
 *  - A row the backup would put back points at a row in a section that was NOT chosen, and that
 *    row no longer exists (a wiki page whose author has been deleted since). Putting it back
 *    would fail the foreign key, and resurrecting the author would undo something the person did
 *    not ask to undo. The row is SKIPPED, and so is everything in the chosen sections that
 *    depends on it.
 *  - A row the restore would delete (it is not in the backup) is still used by a row in a
 *    section that was NOT chosen. Deleting it would be refused, or worse, a cascading delete
 *    would silently remove data the person chose not to touch. The row is KEPT, and so is
 *    whatever it in turn needs.
 *
 * Both are worked out here, before anything is written, on the same plan a restore then follows,
 * so the report a person reads is exactly what happens.
 */

/** The part of a table's plan this module changes (see TablePlan in backup-diff). */
export interface PlanLike {
  addedKeys: string[];
  changedKeys: string[];
  removedKeys: string[];
  deleteAll: boolean;
  /** Rows to write with some columns emptied: row key -> the columns whose parent is gone (optional links only). */
  nullify?: Map<string, string[]>;
  /** Rows to write owned by the "Unknown user" placeholder: row key -> the columns (a required owner or author that is gone). */
  reassign?: Map<string, string[]>;
}

export interface SkippedRows {
  table: string;
  count: number;
  /** The table whose missing rows are the reason. */
  parent: string;
  /** The parent is part of this restore (and could not itself be put back) rather than left alone. */
  parentInScope: boolean;
  /** Not skipped: put back with the optional link to the missing parent left empty (what the database does when it is deleted). */
  emptied?: boolean;
  /** Not skipped: put back under the "Unknown user" placeholder, because the person who owned it is not here. */
  reassigned?: boolean;
}

/**
 * The placeholder owner for content whose person is gone (restoring the wiki onto a fresh install, say): a disabled,
 * deleted-looking account that cannot sign in and has no groups. Created by a restore only when something needs it.
 */
export const UNKNOWN_USER = { id: "00000000-0000-4000-8000-0000000000ff", name: "Unknown user", email: "unknown-user@restored.invalid" } as const;

/** Required owner/author columns that may fall back to the placeholder. Personal data (layouts, tokens ...) and assignments never do. */
export const REASSIGNABLE_TO_UNKNOWN = new Set(["notes.owner_user_id", "tickets.created_by_user_id", "ticket_comments.author_user_id", "wiki_pages.owner_user_id"]);

export interface KeptRows {
  table: string;
  count: number;
  /** Tables outside the restore whose rows still use them. */
  usedBy: string[];
}

const CHUNK = 500;
const id = (name: string) => sql.identifier(name);

/** A foreign key that points at the parent's whole primary key, in order: the only kind this module can follow. */
function usableParent(fk: ForeignKeyMeta): TableMeta | null {
  const parent = tableMeta(fk.parent);
  if (!parent) return null;
  if (fk.parentColumns.length !== parent.pk.length || !fk.parentColumns.every((c, i) => c === parent.pk[i])) return null;
  return parent;
}

/** The key (as keyOf makes it) of the parent row a foreign key points at; null when a column is empty. */
export function parentKeyOf(row: Row, fk: ForeignKeyMeta, parent: TableMeta): string | null {
  const pseudo: Row = {};
  for (let i = 0; i < fk.columns.length; i++) {
    const v = row[fk.columns[i]!];
    if (v === null || v === undefined) return null;
    pseudo[fk.parentColumns[i]!] = v;
  }
  return keyOf(pseudo, parent.pk);
}

/**
 * Rows to skip because the row they point at in the SAME table is skipped. `parents` maps a row's
 * key to the keys of the rows it points at; `skipped` is added to until nothing more follows.
 */
export function skipThroughSelfReference(parents: Map<string, string[]>, skipped: Set<string>): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const [key, points] of parents) {
      if (skipped.has(key)) continue;
      if (points.some((p) => skipped.has(p))) {
        skipped.add(key);
        changed = true;
      }
    }
  }
}

/** A predicate on arbitrary columns of `table` (not its key): rows whose columns equal one of the given value lists. */
function columnsPredicate(table: TableMeta, columns: string[], keys: string[]) {
  const byName = new Map(table.columns.map((c) => [c.name, c]));
  const cols = columns.map((c) => byName.get(c)!);
  if (cols.length === 1) {
    const col = cols[0]!;
    const values = keys.map((k) => keyValues(k)[0]);
    return sql`${id(col.name)} IN (${sql.join(values.map((v) => param(col, v)), sql`, `)})`;
  }
  const tuples = keys.map((k) => {
    const v = keyValues(k);
    return sql`(${sql.join(cols.map((c, i) => param(c, v[i])), sql`, `)})`;
  });
  return sql`(${sql.join(cols.map((c) => id(c.name)), sql`, `)}) IN (${sql.join(tuples, sql`, `)})`;
}

/** Which of `keys` exist in `table` right now. */
async function existingKeys(db: Db, table: TableMeta, keys: string[]): Promise<Set<string>> {
  const present = new Set<string>();
  for (let i = 0; i < keys.length; i += CHUNK) {
    const chunk = keys.slice(i, i + CHUNK);
    const res = await db.execute(sql`SELECT ${selectList(table, table.pk)} FROM ${id(table.name)} WHERE ${keysPredicate(table, chunk)}`);
    for (const row of res.rows as Row[]) present.add(keyOf(row, table.pk));
  }
  return present;
}

/**
 * Step 1: drop from the plans the rows a restore cannot put back because a row they depend on is
 * gone and is not part of the restore (or could not be put back itself). Streams the archive once.
 */
export async function skipRowsWithMissingParents(
  deps: { db: Db },
  plans: Map<string, PlanLike>,
  scope: Set<string>,
  archive: () => AsyncIterable<Buffer>,
): Promise<SkippedRows[]> {
  const work = new Map<string, { meta: TableMeta; candidates: Set<string> }>();
  for (const meta of backedUpTables()) {
    const plan = plans.get(meta.name);
    if (!plan || !scope.has(meta.name) || meta.foreignKeys.length === 0) continue;
    const candidates = new Set([...plan.addedKeys, ...plan.changedKeys]);
    if (candidates.size > 0) work.set(meta.name, { meta, candidates });
  }
  if (work.size === 0) return [];

  const skipped = new Map<string, Set<string>>();
  const live = new Map<string, Map<string, boolean>>(); // parent table outside the restore -> key -> exists
  const out = new Map<string, SkippedRows>();
  const note = (table: string, parent: string, inScope: boolean, how: "skipped" | "emptied" | "reassigned" = "skipped") => {
    const k = `${table}\u0000${parent}\u0000${how}`;
    const e = out.get(k) ?? { table, count: 0, parent, parentInScope: inScope, ...(how === "emptied" ? { emptied: true } : how === "reassigned" ? { reassigned: true } : {}) };
    e.count++;
    out.set(k, e);
  };

  const resolve = async (meta: TableMeta, rows: Array<{ key: string; row: Row }>): Promise<void> => {
    const fks = meta.foreignKeys.map((fk) => ({ fk, parent: usableParent(fk) })).filter((x): x is { fk: ForeignKeyMeta; parent: TableMeta } => x.parent !== null);
    // Parents outside the restore: ask the database once for all the keys this table needs.
    for (const { fk, parent } of fks) {
      if (parent.name === meta.name || scope.has(parent.name)) continue;
      const cache = live.get(parent.name) ?? new Map<string, boolean>();
      live.set(parent.name, cache);
      const needed = new Set<string>();
      for (const { row } of rows) {
        const k = parentKeyOf(row, fk, parent);
        if (k !== null && !cache.has(k)) needed.add(k);
      }
      if (needed.size > 0) {
        const present = await existingKeys(deps.db, parent, [...needed]);
        for (const k of needed) cache.set(k, present.has(k));
      }
    }
    const mine = new Set<string>();
    const selfParents = new Map<string, string[]>();
    const notNull = new Map(meta.columns.map((c) => [c.name, c.notNull]));
    const nullify = new Map<string, string[]>();
    const reassign = new Map<string, string[]>();
    for (const { key, row } of rows) {
      let reason: { parent: string; inScope: boolean } | null = null;
      let emptiedBy: { parent: string; inScope: boolean } | null = null;
      let reassignedBy: { parent: string; inScope: boolean } | null = null;
      const empties = new Set<string>();
      const owners = new Set<string>();
      const own: string[] = [];
      for (const { fk, parent } of fks) {
        const pk = parentKeyOf(row, fk, parent);
        if (pk === null) continue;
        if (parent.name === meta.name) {
          own.push(pk);
          continue;
        }
        const inScope = scope.has(parent.name);
        const gone = inScope ? (skipped.get(parent.name)?.has(pk) ?? false) : live.get(parent.name)?.get(pk) === false;
        if (!gone) continue;
        if (fk.columns.every((c) => notNull.get(c) === false)) {
          // An optional link (a creator, an assignee): the row is still worth restoring without it.
          for (const c of fk.columns) empties.add(c);
          emptiedBy ??= { parent: parent.name, inScope };
        } else if (parent.name === "users" && fk.columns.length === 1 && REASSIGNABLE_TO_UNKNOWN.has(`${meta.name}.${fk.columns[0]}`)) {
          owners.add(fk.columns[0]!);
          reassignedBy ??= { parent: parent.name, inScope };
        } else if (!reason) {
          reason = { parent: parent.name, inScope };
        }
      }
      if (own.length > 0) selfParents.set(key, own);
      if (reason) {
        mine.add(key);
        note(meta.name, reason.parent, reason.inScope);
      } else {
        if (emptiedBy) {
          nullify.set(key, [...empties]);
          note(meta.name, emptiedBy.parent, emptiedBy.inScope, "emptied");
        }
        if (reassignedBy) {
          reassign.set(key, [...owners]);
          note(meta.name, reassignedBy.parent, reassignedBy.inScope, "reassigned");
        }
      }
    }
    if (nullify.size > 0) plans.get(meta.name)!.nullify = nullify;
    if (reassign.size > 0) plans.get(meta.name)!.reassign = reassign;
    // A row that points at a skipped row of the same table (a folder inside a skipped folder).
    const before = new Set(mine);
    skipThroughSelfReference(selfParents, mine);
    for (const key of mine) if (!before.has(key)) note(meta.name, meta.name, true);
    skipped.set(meta.name, mine);
    if (mine.size > 0) {
      const plan = plans.get(meta.name)!;
      plan.addedKeys = plan.addedKeys.filter((k) => !mine.has(k));
      plan.changedKeys = plan.changedKeys.filter((k) => !mine.has(k));
    }
  };

  let current: { meta: TableMeta; candidates: Set<string> } | null = null;
  let buffer: Array<{ key: string; row: Row }> = [];
  for await (const event of readArchive(archive())) {
    if (event.type === "tableStart") {
      current = work.get(event.table) ?? null;
      buffer = [];
    } else if (event.type === "rows" && current) {
      const cols = new Set(current.meta.foreignKeys.flatMap((fk) => fk.columns));
      for (const row of event.rows) {
        const key = keyOf(row, current.meta.pk);
        if (!current.candidates.has(key)) continue;
        const slim: Row = {};
        for (const c of cols) slim[c] = row[c];
        buffer.push({ key, row: slim });
      }
    } else if (event.type === "tableEnd" && current) {
      await resolve(current.meta, buffer);
      current = null;
      buffer = [];
    } else if (event.type === "files" || event.type === "file" || event.type === "summary") {
      break;
    }
  }
  return [...out.values()];
}

/**
 * Step 2: take out of the plans the deletions a restore must not make because a row outside the
 * restore (or a row that is itself kept) still uses the row. Children are handled before their
 * parents, so a kept row keeps what it needs all the way up.
 */
export async function keepRowsStillInUse(
  deps: { db: Db },
  plans: Map<string, PlanLike>,
  scope: Set<string>,
): Promise<KeptRows[]> {
  const order = backedUpTables().filter((t) => scope.has(t.name) && plans.has(t.name));
  const outside = backedUpTables().filter((t) => !scope.has(t.name));
  const removedSets = new Map(order.map((t) => [t.name, new Set(plans.get(t.name)!.removedKeys)]));
  const keep = new Map<string, Set<string>>();
  const usedBy = new Map<string, Set<string>>();
  const out: KeptRows[] = [];

  /** Live rows of a table by key, with the columns the foreign keys need. */
  const fetchLive = async (meta: TableMeta, keys: string[]): Promise<Row[]> => {
    const cols = [...new Set([...meta.pk, ...meta.foreignKeys.flatMap((fk) => fk.columns)])];
    const rows: Row[] = [];
    for (let i = 0; i < keys.length; i += CHUNK) {
      const res = await deps.db.execute(sql`SELECT ${selectList(meta, cols)} FROM ${id(meta.name)} WHERE ${keysPredicate(meta, keys.slice(i, i + CHUNK))}`);
      rows.push(...(res.rows as Row[]));
    }
    return rows;
  };

  /** A kept row keeps the rows it points at: add those (in this table or an earlier one of the restore) that would be deleted. */
  const propagate = async (meta: TableMeta, fresh: string[]): Promise<void> => {
    let queue = fresh;
    while (queue.length > 0) {
      const next: string[] = [];
      for (const row of await fetchLive(meta, queue)) {
        for (const fk of meta.foreignKeys) {
          const parent = usableParent(fk);
          if (!parent || !scope.has(parent.name) || !plans.has(parent.name)) continue;
          const pk = parentKeyOf(row, fk, parent);
          if (pk === null || !removedSets.get(parent.name)!.has(pk)) continue;
          const set = keep.get(parent.name) ?? new Set<string>();
          keep.set(parent.name, set);
          if (set.has(pk)) continue;
          set.add(pk);
          if (parent.name === meta.name) next.push(pk);
        }
      }
      queue = next;
    }
  };

  for (const meta of [...order].reverse()) {
    const plan = plans.get(meta.name)!;
    const set = keep.get(meta.name) ?? new Set<string>();
    keep.set(meta.name, set);
    const removed = removedSets.get(meta.name)!;
    if (removed.size === 0) continue;

    // Rows outside the restore that point at rows this table is about to lose.
    const users = new Set<string>();
    for (const child of outside) {
      for (const fk of child.foreignKeys) {
        if (fk.parent !== meta.name || usableParent(fk) === null) continue;
        for (let i = 0; i < plan.removedKeys.length; i += CHUNK) {
          const chunk = plan.removedKeys.slice(i, i + CHUNK);
          const res = await deps.db.execute(
            sql`SELECT DISTINCT ${selectList(child, fk.columns)} FROM ${id(child.name)} WHERE ${columnsPredicate(child, fk.columns, chunk)}`,
          );
          for (const row of res.rows as Row[]) {
            const k = parentKeyOf(row, fk, meta);
            if (k !== null && removed.has(k)) {
              set.add(k);
              users.add(child.name); // every table that uses it is named, not just the first
            }
          }
        }
      }
    }
    if (users.size > 0) usedBy.set(meta.name, users);

    // Rows kept (by a child, or because another row of this table needs them) keep their own parents.
    await propagate(meta, [...set]);
    if (set.size === 0) continue;
    plan.removedKeys = plan.removedKeys.filter((k) => !set.has(k));
    plan.deleteAll = false; // "delete everything" can no longer be a bare DELETE
    out.push({ table: meta.name, count: set.size, usedBy: [...(usedBy.get(meta.name) ?? [])].sort() });
  }
  return out;
}
