import { createHash } from "node:crypto";
import { finished } from "node:stream/promises";
import type { Readable } from "node:stream";
import { VERIFY_MAX_PROBLEMS } from "@church/shared";
import type { ArchiveEvent, Manifest } from "./archive";
import { gunzipped } from "./archive";
import { inspectArchive } from "./backup-inspect";
import { tableMeta, type TableMeta } from "./backup-schema";
import { TABLE_REGISTRY } from "./table-registry";
import { keyOf, type Row } from "./row-codec";

/**
 * Whether a restore could use the rows in an archive, judged from the archive alone (nothing is read from or written to the
 * database): keys present and unique, required columns filled, and every foreign key pointing at a row that is in the
 * archive. A backup is one serializable snapshot, so a dangling reference means the file is wrong, not that it is old.
 * Tables this version no longer restores are left out, as a restore leaves them out.
 */
export class ContentChecker {
  private readonly problems: string[] = [];
  private extra = 0;
  private manifest: Manifest | null = null;
  private current: { meta: TableMeta; columns: Set<string>; keys: Set<string> } | null = null;
  /** Primary keys of every restorable table that has finished, for the foreign-key look. */
  private readonly done = new Map<string, Set<string>>();
  /** References whose parent had not been read when they were seen (a parent later in the file, or the table itself). */
  private readonly later: Array<{ table: string; parent: string; column: string; key: string }> = [];
  rows = 0;
  tables = 0;

  private add(problem: string): void {
    if (this.problems.length < VERIFY_MAX_PROBLEMS) this.problems.push(problem);
    else this.extra++;
  }

  observe(event: ArchiveEvent): void {
    if (event.type === "manifest") {
      this.manifest = event.manifest;
    } else if (event.type === "tableStart") {
      this.start(event.table);
    } else if (event.type === "rows") {
      for (const row of event.rows) this.row(row);
    } else if (event.type === "tableEnd") {
      this.end(event.table);
    }
  }

  private start(name: string): void {
    this.current = null;
    const meta = tableMeta(name);
    const mt = this.manifest?.tables.find((t) => t.name === name);
    if (!meta || !mt || TABLE_REGISTRY[name]?.policy !== "data") return; // a restore ignores it too
    const columns = new Set(mt.columns.map((c) => c.name).filter((c) => meta.columns.some((m) => m.name === c)));
    const missing = meta.columns.filter((c) => c.notNull && !c.hasDefault && !columns.has(c.name));
    if (missing.length > 0) {
      this.add(`${name} needs ${missing.map((c) => c.name).join(", ")}, which this backup does not have, so it cannot be restored by this version.`);
      return;
    }
    if (!meta.pk.every((c) => columns.has(c))) {
      this.add(`${name}: the backup's key columns differ from this version's.`);
      return;
    }
    this.current = { meta, columns, keys: new Set() };
    this.tables++;
  }

  private row(row: Row): void {
    const cur = this.current;
    if (!cur) return;
    const { meta, columns, keys } = cur;
    this.rows++;
    const name = meta.name;
    if (meta.pk.some((c) => row[c] === null || row[c] === undefined)) {
      this.add(`${name} has a row with no key.`);
      return;
    }
    const key = keyOf(row, meta.pk);
    if (keys.has(key)) this.add(`${name} has the same key twice: ${key}.`);
    keys.add(key);
    for (const c of meta.columns) {
      if (c.notNull && columns.has(c.name) && (row[c.name] === null || row[c.name] === undefined)) {
        this.add(`${name} row ${key} has no value for ${c.name}, which is required.`);
      }
    }
    for (const fk of meta.foreignKeys) {
      const refs = fk.columns.map((c) => row[c]);
      if (refs.some((v) => v === null || v === undefined)) continue; // an optional link left empty
      const parentKeys = fk.parent === name ? null : this.done.get(fk.parent);
      // The parent's key is written in its primary key's column order, whatever order the foreign key names them in.
      const parentPk = tableMeta(fk.parent)?.pk ?? fk.parentColumns;
      const ref = JSON.stringify(parentPk.map((c) => String(refs[fk.parentColumns.indexOf(c)])));
      if (fk.parent !== name && !this.willBeKnown(fk.parent)) continue; // the parent is not part of backups, or not in this one
      if (parentKeys) {
        if (!parentKeys.has(ref)) this.add(`${name} row ${key} points to a row in ${fk.parent} that is not in the backup (${fk.columns.join(", ")}).`);
      } else {
        this.later.push({ table: name, parent: fk.parent, column: fk.columns.join(", "), key: `${key}\u0000${ref}` });
      }
    }
  }

  private willBeKnown(parent: string): boolean {
    return this.manifest?.tables.some((t) => t.name === parent) === true && TABLE_REGISTRY[parent]?.policy === "data" && tableMeta(parent) !== undefined;
  }

  private end(name: string): void {
    const cur = this.current;
    if (cur && cur.meta.name === name) this.done.set(name, cur.keys);
    this.current = null;
  }

  /** Call once the archive has been read through. */
  finish(): { problems: string[]; rows: number; tables: number } {
    for (const l of this.later) {
      const parent = this.done.get(l.parent) ?? (l.parent === l.table ? this.done.get(l.table) : undefined);
      const [key, ref] = l.key.split("\u0000") as [string, string];
      if (!parent) this.add(`${l.table} row ${key} points to ${l.parent}, which is not in the backup.`);
      else if (!parent.has(ref)) this.add(`${l.table} row ${key} points to a row in ${l.parent} that is not in the backup (${l.column}).`);
    }
    const problems = [...this.problems];
    if (this.extra > 0) problems.push(`... and ${this.extra} more.`);
    return { problems, rows: this.rows, tables: this.tables };
  }
}

/** A message fit to show: ours already read as sentences; a parser's ("Unexpected token ...") gets a plain lead-in. */
function readable(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return /^(The|This|Backup) /.test(msg) ? msg : `The stored file is damaged and could not be read through (${msg.slice(0, 200)}).`;
}

export interface VerifyReport {
  ok: boolean;
  /** What is wrong, in words fit to show. Empty when `ok`. */
  problems: string[];
  rows: number;
  tables: number;
  files: number;
  /** Bytes of the stored (compressed) archive that were read. */
  bytes: number;
}

/**
 * Re-read a stored archive from its first byte to its last and say whether it is whole and usable: the checksum and size
 * recorded when it was made, a clean decompression, row counts and file checksums as the summary says, and the rows
 * themselves (see {@link ContentChecker}). Never throws for something wrong with the backup; a store that cannot be read is
 * reported as a problem too, so the caller records one outcome either way.
 */
export async function verifyStoredArchive(
  open: () => Promise<Readable>,
  expected: { sha256: string | null; sizeBytes: number | null },
): Promise<VerifyReport> {
  const checker = new ContentChecker();
  const hash = createHash("sha256");
  let bytes = 0;
  let files = 0;
  const problems: string[] = [];
  let source: Readable | null = null;
  try {
    source = await open();
    source.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      bytes += chunk.length;
    });
    try {
      const info = await inspectArchive(gunzipped(source), (e) => checker.observe(e));
      files = info.fileCount;
      // The tar ends before the compressed stream does; read the rest so the checksum covers the whole file.
      source.resume();
      await finished(source, { writable: false });
    } catch (err) {
      problems.push(readable(err));
    }
  } catch (err) {
    problems.push(`The stored file could not be read: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    source?.destroy();
  }

  const content = checker.finish();
  if (problems.length === 0) {
    const sha = hash.digest("hex");
    if (expected.sizeBytes !== null && bytes !== expected.sizeBytes) {
      problems.push(`The stored file is ${bytes} bytes but ${expected.sizeBytes} were written: it has been damaged or replaced.`);
    } else if (expected.sha256 && sha !== expected.sha256) {
      problems.push("The stored file does not match the checksum recorded when it was made: it has been damaged or replaced.");
    }
    problems.push(...content.problems);
  }
  return { ok: problems.length === 0, problems, rows: content.rows, tables: content.tables, files, bytes };
}
