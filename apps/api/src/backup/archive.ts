import { createGunzip } from "node:zlib";
import { pipeline, type Readable } from "node:stream";
import { readTar } from "./tar";
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
      if (manifest.format !== ARCHIVE_FORMAT) throw new Error("This is not a dashboard backup (wrong format marker).");
      if (manifest.version !== ARCHIVE_VERSION) {
        throw new Error(`Backup format version ${manifest.version} is not supported by this version of the dashboard.`);
      }
      yield { type: "manifest", manifest };
    } else if (tableMatch) {
      const table = decodeURIComponent(tableMatch[1]!);
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
      yield { type: "files", files: JSON.parse((await entry.buffer(MAX_JSON_ENTRY)).toString("utf8")) as FileIndexEntry[] };
    } else if (entry.name.startsWith("files/")) {
      yield { type: "file", key: entry.name.slice("files/".length), size: entry.size, body: () => entry.body() };
    } else if (entry.name === "summary.json") {
      yield { type: "summary", summary: JSON.parse((await entry.buffer(MAX_JSON_ENTRY)).toString("utf8")) as Summary };
    }
    // Anything else is from a newer writer and is ignored.
  }
  if (openTable) yield { type: "tableEnd", table: openTable };
}

/** Decompress a stored backup, passing a read error on to whoever is iterating. */
export function gunzipped(source: Readable): Readable {
  const gunzip = createGunzip();
  pipeline(source, gunzip, () => undefined);
  return gunzip;
}

export function tablePartName(table: string, part: number): string {
  return `tables/${encodeURIComponent(table)}/${String(part).padStart(6, "0")}.ndjson`;
}
