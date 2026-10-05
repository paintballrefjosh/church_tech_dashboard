import { sql } from "drizzle-orm";
import { findKnownSetting } from "@church/shared";
import type {
  BackupCompatibility,
  BackupDiffChangedRow,
  BackupDiffColumnChange,
  BackupDiffFiles,
  BackupDiffGroup,
  BackupDiffReport,
  BackupDiffRow,
  BackupDiffTable,
  BackupProgress,
} from "@church/shared";
import type { Db } from "../db/db.module";
import { backedUpTables, tableMeta, type TableMeta } from "./backup-schema";
import { TABLE_REGISTRY, tableInfo } from "./table-registry";
import { canonicalJson, keyOf, keyValues, keysPredicate, rowFingerprint, selectList, shorten, type Row } from "./row-codec";
import { appliedMigrations, readPage } from "./backup-writer";
import { readArchive, type ArchiveEvent, type FileIndexEntry, type Manifest } from "./archive";
import { FILES_PREFIX, type ObjectStore } from "./object-store";

const id = (name: string) => sql.identifier(name);
const SAMPLES = 15;

/** What a restore will do to one table, row by row. */
export interface TablePlan {
  table: string;
  /** The backup has no such table (it was made before the table existed): a restore empties it. */
  deleteAll: boolean;
  addedKeys: string[];
  changedKeys: string[];
  removedKeys: string[];
  /** Columns a restore writes (those both the backup and the current schema have). */
  columns: string[];
  /** Columns that decide whether a row "changed": `columns` without the volatile ones. */
  compareColumns: string[];
}

export interface DiffDeps {
  db: Db;
  store: ObjectStore;
  progress?: (p: BackupProgress) => void | Promise<void>;
}

export interface DiffContext {
  backup: { id: string; name: string; createdAt: string };
  /** A fresh decompressed stream of the backup, each time it is called. */
  archive: () => AsyncIterable<Buffer>;
  secretFingerprint: string;
  /** The person asking, to say what happens to their own account. */
  userId?: string | null;
  /**
   * Called for the file index, every file and the summary while walking the archive, which then
   * runs to the end. Without it the walk stops at the first file. A restore uses it to put the files back.
   */
  onTail?: (event: Extract<ArchiveEvent, { type: "files" | "file" | "summary" }>) => Promise<void>;
}

export interface DiffOutput {
  report: BackupDiffReport;
  plans: Map<string, TablePlan>;
  manifest: Manifest;
  fileIndex: FileIndexEntry[] | null;
  /** The files in storage now (key, size), for a restore to decide what to put and what to drop. */
  storageFiles: Map<string, number> | null;
}

function intersection(current: TableMeta, backup: Manifest["tables"][number]): string[] {
  const have = new Set(backup.columns.map((c) => c.name));
  return current.columns.map((c) => c.name).filter((c) => have.has(c));
}

function labelOf(table: string, row: Row, keyCols: string[]): string {
  const info = TABLE_REGISTRY[table];
  const parts: string[] = [];
  for (const col of info?.label ?? []) {
    const v = row[col];
    if (v !== null && v !== undefined && String(v).trim() !== "") parts.push(shorten(typeof v === "string" ? v.replace(/\s+/g, " ") : v, 80)!);
    if (parts.length >= 2) break;
  }
  return parts.length > 0 ? parts.join(" - ") : keyCols.map((c) => String(row[c])).join(" / ");
}

function isSecret(table: string, column: string, row: Row): boolean {
  if (TABLE_REGISTRY[table]?.sensitive?.includes(column)) return true;
  if (table === "settings" && column === "value") return findKnownSetting(String(row.key))?.type === "secret";
  return false;
}

async function scanCurrent(db: Db, table: TableMeta, columns: string[], visit: (row: Row) => void): Promise<void> {
  const cols = [...new Set([...table.pk, ...columns])];
  await db.transaction(
    async (tx) => {
      await tx.execute(sql`SELECT set_config('TimeZone', 'UTC', true)`);
      let after: Row | null = null;
      for (;;) {
        const page = await readPage(tx, table, cols, after);
        for (const row of page) visit(row);
        if (page.length < 500) break;
        after = page[page.length - 1]!;
      }
    },
    { isolationLevel: "serializable", accessMode: "read only" },
  );
}

async function fetchCurrentRows(db: Db, table: TableMeta, keys: string[]): Promise<Map<string, Row>> {
  const out = new Map<string, Row>();
  if (keys.length === 0) return out;
  await db.transaction(
    async (tx) => {
      await tx.execute(sql`SELECT set_config('TimeZone', 'UTC', true)`);
      const res = await tx.execute(
        sql`SELECT ${selectList(table, table.columns.map((c) => c.name))} FROM ${id(table.name)} WHERE ${keysPredicate(table, keys)}`,
      );
      for (const row of res.rows as Row[]) out.set(keyOf(row, table.pk), row);
    },
    { isolationLevel: "serializable", accessMode: "read only" },
  );
  return out;
}

function changesBetween(table: string, current: Row, backup: Row, columns: string[]): BackupDiffColumnChange[] {
  const out: BackupDiffColumnChange[] = [];
  for (const c of columns) {
    if (canonicalJson(current[c]) === canonicalJson(backup[c])) continue;
    const secret = isSecret(table, c, current) || isSecret(table, c, backup);
    out.push(
      secret
        ? { column: c, current: null, backup: null, secret: true }
        : { column: c, current: shorten(current[c]), backup: shorten(backup[c]) },
    );
  }
  return out;
}

/**
 * Compare a backup with the database as it is now: per table, which rows a restore would bring
 * back, delete or put back as they were. Streams the archive (never holds a table) and returns
 * both the human report and the exact plan a restore then follows.
 */
export async function computeDiff(deps: DiffDeps, ctx: DiffContext): Promise<DiffOutput> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const plans = new Map<string, TablePlan>();
  const tableReports = new Map<string, BackupDiffTable>();
  const wantBackupRows = new Map<string, Set<string>>();

  let manifest: Manifest | null = null;
  let fileIndex: FileIndexEntry[] | null = null;
  const currentTables = backedUpTables();
  const seen = new Set<string>();
  let hashes: Map<string, string> | null = null;
  let openMeta: TableMeta | null = null;
  let openCols: { all: string[]; compare: string[] } | null = null;
  let tableBackupRows = 0;
  let tableIndex = 0;

  const finishTable = async (name: string) => {
    const meta = openMeta;
    const cols = openCols;
    const backupHashes = hashes;
    openMeta = null;
    openCols = null;
    hashes = null;
    if (!meta || !cols || !backupHashes) return;
    await deps.progress?.({ label: `Comparing ${tableInfo(name).title.toLowerCase()}`, done: tableIndex++, total: currentTables.length });

    const remaining = new Map(backupHashes);
    const addedKeys: string[] = [];
    const changedKeys: string[] = [];
    const removedKeys: string[] = [];
    let currentRows = 0;
    let unchanged = 0;
    await scanCurrent(deps.db, meta, cols.compare, (row) => {
      currentRows++;
      const key = keyOf(row, meta.pk);
      const theirs = remaining.get(key);
      if (theirs === undefined) {
        removedKeys.push(key);
        return;
      }
      remaining.delete(key);
      if (theirs === rowFingerprint(row, cols.compare)) unchanged++;
      else changedKeys.push(key);
    });
    for (const key of remaining.keys()) addedKeys.push(key);

    plans.set(name, { table: name, deleteAll: false, addedKeys, changedKeys, removedKeys, columns: cols.all, compareColumns: cols.compare });
    tableReports.set(name, {
      table: name,
      title: tableInfo(name).title,
      backupRows: tableBackupRows,
      currentRows,
      added: addedKeys.length,
      removed: removedKeys.length,
      changed: changedKeys.length,
      unchanged,
      samples: { added: [], removed: [], changed: [] },
    });
    const wants = new Set([...addedKeys.slice(0, SAMPLES), ...changedKeys.slice(0, SAMPLES)]);
    if (wants.size > 0) wantBackupRows.set(name, wants);
  };

  // ---- pass 1: the tables, in archive order ----
  for await (const event of readArchive(ctx.archive())) {
    if (event.type === "manifest") {
      manifest = event.manifest;
    } else if (event.type === "tableStart") {
      const meta = tableMeta(event.table);
      const mt = manifest?.tables.find((t) => t.name === event.table);
      seen.add(event.table);
      if (!meta || !mt || !TABLE_REGISTRY[event.table] || TABLE_REGISTRY[event.table]!.policy !== "data") {
        warnings.push(`The backup has "${event.table}", which this version no longer saves or restores: it is ignored.`);
        continue;
      }
      const all = intersection(meta, mt);
      const volatile = new Set(tableInfo(event.table).volatile ?? []);
      for (const c of mt.columns) {
        if (!meta.columns.some((m) => m.name === c.name)) warnings.push(`${event.table}.${c.name} no longer exists: its values in the backup are ignored.`);
      }
      const missingRequired = meta.columns.filter((c) => c.notNull && !c.hasDefault && !mt.columns.some((b) => b.name === c.name));
      if (missingRequired.length > 0) {
        errors.push(`${event.table} needs ${missingRequired.map((c) => c.name).join(", ")}, which this backup does not have (it is too old for this version).`);
        continue;
      }
      if (!meta.pk.every((c) => all.includes(c))) {
        errors.push(`${event.table}: the backup's key columns differ from this version's.`);
        continue;
      }
      openMeta = meta;
      openCols = { all, compare: all.filter((c) => !volatile.has(c)) };
      hashes = new Map();
      tableBackupRows = 0;
    } else if (event.type === "rows") {
      if (openMeta && openCols && hashes) {
        for (const row of event.rows) {
          hashes.set(keyOf(row, openMeta.pk), rowFingerprint(row, openCols.compare));
          tableBackupRows++;
        }
      }
    } else if (event.type === "tableEnd") {
      await finishTable(event.table);
    } else if (event.type === "files") {
      fileIndex = event.files;
      if (ctx.onTail) await ctx.onTail(event);
      else break;
    } else if (event.type === "file" || event.type === "summary") {
      if (ctx.onTail) await ctx.onTail(event);
      else break;
    }
  }
  if (!manifest) throw new Error("This is not a dashboard backup (no manifest).");

  // Tables this version saves that the backup has none of: a restore empties them.
  for (const meta of currentTables) {
    if (seen.has(meta.name)) continue;
    const info = tableInfo(meta.name);
    const keys: string[] = [];
    await scanCurrent(deps.db, meta, [], (row) => keys.push(keyOf(row, meta.pk)));
    plans.set(meta.name, { table: meta.name, deleteAll: true, addedKeys: [], changedKeys: [], removedKeys: keys, columns: [], compareColumns: [] });
    tableReports.set(meta.name, {
      table: meta.name,
      title: info.title,
      backupRows: 0,
      currentRows: keys.length,
      added: 0,
      removed: keys.length,
      changed: 0,
      unchanged: 0,
      samples: { added: [], removed: [], changed: [] },
    });
    if (keys.length > 0) warnings.push(`The backup has no "${info.title.toLowerCase()}" (it predates them): a restore empties them.`);
  }

  // ---- sample details: current rows from the database, backup rows from a second pass ----
  const currentSample = new Map<string, Map<string, Row>>();
  for (const [name, plan] of plans) {
    const meta = tableMeta(name)!;
    const report = tableReports.get(name)!;
    const keys = [...plan.removedKeys.slice(0, SAMPLES), ...plan.changedKeys.slice(0, SAMPLES)];
    const rows = await fetchCurrentRows(deps.db, meta, keys);
    currentSample.set(name, rows);
    for (const key of plan.removedKeys.slice(0, SAMPLES)) {
      const row = rows.get(key);
      if (row) report.samples.removed.push({ key: keyValues(key).join(" / "), label: labelOf(name, row, meta.pk) });
    }
  }
  if (wantBackupRows.size > 0) {
    const pending = new Set(wantBackupRows.keys());
    for await (const event of readArchive(ctx.archive())) {
      if (event.type === "rows" && wantBackupRows.has(event.table)) {
        const wants = wantBackupRows.get(event.table)!;
        const meta = tableMeta(event.table)!;
        const plan = plans.get(event.table)!;
        const report = tableReports.get(event.table)!;
        const current = currentSample.get(event.table)!;
        for (const row of event.rows) {
          const key = keyOf(row, meta.pk);
          if (!wants.has(key)) continue;
          if (plan.changedKeys.includes(key)) {
            const now = current.get(key);
            if (now) {
              const changes = changesBetween(event.table, now, row, plan.compareColumns);
              if (changes.length > 0) {
                const entry: BackupDiffChangedRow = { key: keyValues(key).join(" / "), label: labelOf(event.table, now, meta.pk), changes };
                report.samples.changed.push(entry);
              }
            }
          } else {
            report.samples.added.push({ key: keyValues(key).join(" / "), label: labelOf(event.table, row, meta.pk) });
          }
        }
      } else if (event.type === "tableEnd") {
        pending.delete(event.table);
        if (pending.size === 0) break;
      } else if (event.type === "file") {
        break;
      }
    }
  }

  // ---- compatibility ----
  const currentMigrations = await appliedMigrations(deps.db);
  if (manifest.schemaMigrations !== null && currentMigrations !== null && manifest.schemaMigrations > currentMigrations) {
    errors.push(
      `This backup was made by a newer version (${manifest.schemaMigrations} schema migrations; this one has ${currentMigrations}). Upgrade first, then restore.`,
    );
  } else if (manifest.schemaMigrations !== null && currentMigrations !== null && manifest.schemaMigrations < currentMigrations) {
    warnings.push(
      `This backup is from an older version (${manifest.schemaMigrations} schema migrations; now ${currentMigrations}). Columns added since get their default values.`,
    );
  }
  const secretMismatch = manifest.secretFingerprint !== ctx.secretFingerprint;
  if (secretMismatch) {
    warnings.push(
      "This backup was made with a different AUTH_SECRET. Saved passwords and tokens inside settings (SMTP, OAuth client secrets, device credentials) cannot be decrypted by this installation and will have to be entered again.",
    );
  }
  const compatibility: BackupCompatibility = { ok: errors.length === 0, errors, warnings };

  // ---- files ----
  let files: BackupDiffFiles | null = null;
  let storageFiles: Map<string, number> | null = null;
  if (!manifest.includeFiles) {
    warnings.push("This backup has no uploaded files: attachments restored from it may point at files that are missing.");
  } else if (fileIndex) {
    storageFiles = new Map((await deps.store.list(FILES_PREFIX)).map((o) => [o.key, o.size]));
    const wanted = new Map(fileIndex.map((f) => [f.key, f.size]));
    const added = fileIndex.filter((f) => storageFiles!.get(f.key) !== f.size);
    const removed = [...storageFiles].filter(([k]) => !wanted.has(k));
    files = {
      added: added.length,
      addedBytes: added.reduce((n, f) => n + f.size, 0),
      removed: removed.length,
      removedBytes: removed.reduce((n, [, size]) => n + size, 0),
      samples: { added: added.slice(0, 10).map((f) => f.key), removed: removed.slice(0, 10).map(([k]) => k) },
    };
  }

  // ---- assemble ----
  const groups = new Map<string, BackupDiffGroup>();
  const identicalTables: string[] = [];
  let totals = { added: 0, removed: 0, changed: 0, unchanged: 0 };
  for (const report of tableReports.values()) {
    totals = {
      added: totals.added + report.added,
      removed: totals.removed + report.removed,
      changed: totals.changed + report.changed,
      unchanged: totals.unchanged + report.unchanged,
    };
    if (report.added + report.removed + report.changed === 0) {
      identicalTables.push(report.title);
      continue;
    }
    const groupTitle = tableInfo(report.table).group;
    const g = groups.get(groupTitle) ?? { key: groupTitle.toLowerCase().replace(/[^a-z]+/g, "-"), title: groupTitle, tables: [] };
    g.tables.push(report);
    groups.set(groupTitle, g);
  }
  const order = [...new Set(Object.values(TABLE_REGISTRY).map((t) => t.group))];
  const groupList = [...groups.values()].sort((a, b) => order.indexOf(a.title) - order.indexOf(b.title));
  for (const g of groupList) g.tables.sort((a, b) => a.title.localeCompare(b.title));

  return {
    report: {
      backupId: ctx.backup.id,
      backupName: ctx.backup.name,
      backupCreatedAt: ctx.backup.createdAt,
      generatedAt: new Date().toISOString(),
      compatibility,
      secretMismatch,
      totals,
      groups: groupList,
      identicalTables: identicalTables.sort(),
      files,
      you: describeYou(ctx.userId ?? null, plans),
    },
    plans,
    manifest,
    fileIndex,
    storageFiles,
  };
}

function describeYou(userId: string | null, plans: Map<string, TablePlan>): BackupDiffReport["you"] {
  if (!userId) return null;
  const key = JSON.stringify([userId]);
  const users = plans.get("users");
  if (users?.removedKeys.includes(key) || (users?.deleteAll ?? false)) {
    return {
      status: "removed",
      detail: "Your own account is not in this backup. After the restore you will be signed out and will not be able to sign back in; another administrator (or the bootstrap admin) would have to let you in.",
    };
  }
  const reasons: string[] = [];
  if (users?.changedKeys.includes(key)) reasons.push("your account's details differ");
  const memberships = plans.get("group_memberships");
  const mine = (k: string) => keyValues(k)[1] === userId;
  if (memberships?.addedKeys.some(mine) || memberships?.removedKeys.some(mine)) reasons.push("your group memberships differ");
  if (reasons.length > 0) {
    return { status: "changed", detail: `Your own account will change: ${reasons.join(" and ")}. Your access after the restore is what the backup says it was.` };
  }
  return { status: "unchanged", detail: "Your own account is the same in the backup." };
}

export type { BackupDiffRow };
