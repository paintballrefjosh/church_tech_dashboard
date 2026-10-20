import { createGunzip } from "node:zlib";
import { pipeline, Transform, type Readable } from "node:stream";
import { readTar } from "./tar";
import { FILES_PREFIX } from "./object-store";
import type { Row } from "./row-codec";

/**
 * The backup file format (version 1). A `.tar.gz` whose entries come in this order, which a
 * reader relies on (a comparison stops at the first file, a restore's database pass too):
 *
 *   manifest.json                      who/what/when, the schema, which tables follow
 *   tables/<table>/<000001>.ndjson     the rows, one JSON object per line, in parts of a few MB
 *                                      (parents before children; every table has at least one part)
 *   files.json                         what the file entries below are (key, size, type)
 *   files/<object key>                 each uploaded file, byte for byte
 *   summary.json                       row counts and a SHA-256 for every file, written last
 */
export const ARCHIVE_FORMAT = "church-dashboard-backup";
export const ARCHIVE_VERSION = 1;

export interface ManifestTable {
  name: string;
  columns: Array<{ name: string; type: string }>;
  pk: string[];
}

export interface Manifest {
  format: typeof ARCHIVE_FORMAT;
  version: number;
  id: string;
  name: string;
  createdAt: string;
  appVersion: string | null;
  /** Migrations the database had applied (the backup's schema generation). */
  schemaMigrations: number | null;
  /** Fingerprint of the AUTH_SECRET in force; encrypted settings need the same one to be readable. */
  secretFingerprint: string;
  includeFiles: boolean;
  createdBy: string | null;
  tables: ManifestTable[];
}

export interface FileIndexEntry {
  key: string;
  size: number;
  contentType: string | null;
}

export interface Summary {
  tableCounts: Record<string, number>;
  files: Array<FileIndexEntry & { sha256: string }>;
  /** Files the database listed that were already gone from storage; not in the archive. */
  missingFiles: string[];
  finishedAt: string;
}

export type ArchiveEvent =
  | { type: "manifest"; manifest: Manifest }
  | { type: "tableStart"; table: string }
  | { type: "rows"; table: string; rows: Row[]; bytes: number }
  | { type: "tableEnd"; table: string }
  | { type: "files"; files: FileIndexEntry[] }
  | { type: "file"; key: string; size: number; body: () => AsyncGenerator<Buffer> }
  | { type: "summary"; summary: Summary };

const MAX_JSON_ENTRY = 256 * 1024 * 1024;

const damaged = (what: string) => new Error(`The backup is damaged: ${what}.`);

/**
 * Whether a file key from inside an archive may be written to the object store. A restore puts each file at the key the
 * archive names, so an unchecked key could replace anything in the bucket: another stored backup (the safety backup
 * taken seconds before a restore, for one) or an upload that has nothing to do with the restore. Keys this app writes
 * are `attachments/<kind>/<id><ext>`: anything outside that folder, with a `.`/`..` segment, a control character or a
 * backslash is refused.
 */
export function isSafeFileKey(key: unknown): key is string {
  return (
    typeof key === "string" &&
    key.length > FILES_PREFIX.length &&
    key.length <= 1024 &&
    key.startsWith(FILES_PREFIX) &&
    !/[\u0000-\u001f\u007f\\]/.test(key) &&
    !key.split("/").some((segment) => segment === "." || segment === "..")
  );
}

function assertSafeFileKey(key: unknown): asserts key is string {
  if (!isSafeFileKey(key)) {
    const shown = typeof key === "string" ? JSON.stringify(key.slice(0, 80)) : String(typeof key);
    throw new Error(`This is not a backup made by the dashboard: it holds a file outside the uploads folder (${shown}).`);
  }
}

function assertManifest(m: unknown): asserts m is Manifest {
  const x = m as Partial<Manifest> | null;
  if (!x || typeof x !== "object" || !Array.isArray(x.tables) || x.tables.some((t) => !t || typeof t.name !== "string")) {
    throw damaged("its manifest does not list the tables");
  }
}

function assertFileIndex(files: unknown): asserts files is FileIndexEntry[] {
  if (!Array.isArray(files)) throw damaged("its file list is not a list");
  for (const f of files as Array<Partial<FileIndexEntry> | null>) {
    if (!f || typeof f !== "object") throw damaged("its file list has an entry that is not a file");
    assertSafeFileKey(f.key);
    if (!Number.isSafeInteger(f.size) || (f.size as number) < 0) throw damaged(`the size of ${f.key} is not a number`);
  }
}

function assertSummary(sum: unknown): asserts sum is Summary {
  const x = sum as Partial<Summary> | null;
  if (!x || typeof x !== "object" || !x.tableCounts || typeof x.tableCounts !== "object" || !Array.isArray(x.files)) {
    throw damaged("its summary is incomplete");
  }
  assertFileIndex(x.files);
  for (const f of x.files) if (typeof (f as { sha256?: unknown }).sha256 !== "string") throw damaged(`${f.key} has no checksum`);
}

/**
 * Walk a decompressed backup, yielding what is in it in order. With `parseRows: false` the rows
 * are not parsed (their events carry an empty list): for a pass that only wants the files.
 */
export async function* readArchive(
  source: AsyncIterable<Buffer>,
  options: { parseRows?: boolean } = {},
): AsyncGenerator<ArchiveEvent> {
  const parseRows = options.parseRows !== false;
  let openTable: string | null = null;
  let first = true;
  for await (const entry of readTar(source)) {
    if (first) {
      first = false;
      if (entry.name !== "manifest.json") throw new Error("This is not a dashboard backup (no manifest.json first).");
    }
    const tableMatch = /^tables\/([^/]+)\/\d+\.ndjson$/.exec(entry.name);
    if (!tableMatch && openTable) {
      yield { type: "tableEnd", table: openTable };
      openTable = null;
    }

    if (entry.name === "manifest.json") {
      const manifest = JSON.parse((await entry.buffer(MAX_JSON_ENTRY)).toString("utf8")) as Manifest;
      if (!manifest || manifest.format !== ARCHIVE_FORMAT) throw new Error("This is not a dashboard backup (wrong format marker).");
      if (manifest.version !== ARCHIVE_VERSION) {
        throw new Error(`Backup format version ${manifest.version} is not supported by this version of the dashboard.`);
      }
      assertManifest(manifest);
      yield { type: "manifest", manifest };
    } else if (tableMatch) {
      let table: string;
      try {
        table = decodeURIComponent(tableMatch[1]!);
      } catch {
        throw damaged("a table folder has a name that is not valid");
      }
      if (openTable !== table) {
        if (openTable) yield { type: "tableEnd", table: openTable };
        openTable = table;
        yield { type: "tableStart", table };
      }
      const data = await entry.buffer(MAX_JSON_ENTRY);
      const rows: Row[] = [];
      if (parseRows) {
        for (const line of data.toString("utf8").split("\n")) {
          if (line) rows.push(JSON.parse(line) as Row);
        }
      }
      yield { type: "rows", table, rows, bytes: data.length };
    } else if (entry.name === "files.json") {
      const files: unknown = JSON.parse((await entry.buffer(MAX_JSON_ENTRY)).toString("utf8"));
      assertFileIndex(files);
      yield { type: "files", files };
    } else if (entry.name.startsWith("files/")) {
      const key = entry.name.slice("files/".length);
      assertSafeFileKey(key);
      yield { type: "file", key, size: entry.size, body: () => entry.body() };
    } else if (entry.name === "summary.json") {
      const summary: unknown = JSON.parse((await entry.buffer(MAX_JSON_ENTRY)).toString("utf8"));
      assertSummary(summary);
      yield { type: "summary", summary };
    }
    // Anything else is from a newer writer and is ignored.
  }
  if (openTable) yield { type: "tableEnd", table: openTable };
}

/**
 * How far a backup may expand. Text compresses 10-30 times and uploaded files barely at all, but gzip can reach a
 * thousand to one: a few MB can stand for terabytes that a check or restore would hash and parse for hours while it
 * holds the one-at-a-time backup lease. Past `freeBytes` of output the ratio must stay under `maxRatio`.
 */
export const EXPANSION_FREE_BYTES = 2 * 1024 * 1024 * 1024;
export const EXPANSION_MAX_RATIO = 250;

/** Decompress a stored backup, passing a read error on to whoever is iterating. */
export function gunzipped(
  source: Readable,
  limits: { freeBytes: number; maxRatio: number } = { freeBytes: EXPANSION_FREE_BYTES, maxRatio: EXPANSION_MAX_RATIO },
): Readable {
  let compressed = 0;
  let expanded = 0;
  const countIn = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      compressed += chunk.length;
      cb(null, chunk);
    },
  });
  const guard = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      expanded += chunk.length;
      if (expanded > limits.freeBytes && expanded > compressed * limits.maxRatio) {
        cb(new Error("The file expands far more than a real backup can, so it was stopped. It is damaged or was not made by the dashboard."));
        return;
      }
      cb(null, chunk);
    },
  });
  pipeline(source, countIn, createGunzip(), guard, () => undefined);
  return guard;
}

export function tablePartName(table: string, part: number): string {
  return `tables/${encodeURIComponent(table)}/${String(part).padStart(6, "0")}.ndjson`;
}
