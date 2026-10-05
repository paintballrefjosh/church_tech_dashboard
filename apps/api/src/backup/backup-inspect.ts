import { createHash } from "node:crypto";
import { readArchive, type FileIndexEntry, type Manifest, type Summary } from "./archive";

export interface Inspection {
  manifest: Manifest;
  summary: Summary;
  tableCounts: Record<string, number>;
  fileCount: number;
  fileBytes: number;
}

/**
 * Read a whole backup and check it is intact: well-formed JSON everywhere, row counts that
 * match the summary, every file's size and SHA-256 as recorded. Used on a file somebody uploaded
 * (it may be damaged, or not a backup at all) before it is offered for a restore.
 * Throws an Error with a message fit to show a person.
 */
export async function inspectArchive(source: AsyncIterable<Buffer>): Promise<Inspection> {
  let manifest: Manifest | null = null;
  let summary: Summary | null = null;
  let index: FileIndexEntry[] | null = null;
  const counted: Record<string, number> = {};
  const hashes = new Map<string, { size: number; sha256: string }>();

  try {
    for await (const event of readArchive(source)) {
      if (event.type === "manifest") {
        manifest = event.manifest;
        for (const t of manifest.tables) counted[t.name] = 0;
      } else if (event.type === "rows") {
        counted[event.table] = (counted[event.table] ?? 0) + event.rows.length;
      } else if (event.type === "files") {
        index = event.files;
      } else if (event.type === "file") {
        const h = createHash("sha256");
        let size = 0;
        for await (const chunk of event.body()) {
          h.update(chunk);
          size += chunk.length;
        }
        hashes.set(event.key, { size, sha256: h.digest("hex") });
      } else if (event.type === "summary") {
        summary = event.summary;
      }
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (/incorrect header check|unexpected end of file|invalid (block|stored|distance|code)|data error/i.test(msg)) {
      throw new Error("The file is not a complete, valid backup (it could not be decompressed). Was the download interrupted?");
    }
    throw new Error(msg);
  }

  if (!manifest) throw new Error("This is not a dashboard backup (no manifest).");
  if (!summary) throw new Error("The backup is incomplete: it ends before its summary (the download or upload was probably cut short).");

  for (const [table, rows] of Object.entries(summary.tableCounts)) {
    if ((counted[table] ?? 0) !== rows) {
      throw new Error(`The backup is damaged: ${table} should have ${rows} rows but has ${counted[table] ?? 0}.`);
    }
  }
  for (const f of summary.files) {
    const got = hashes.get(f.key);
    if (!got) throw new Error(`The backup is damaged: the file ${f.key} is listed but missing.`);
    if (got.size !== f.size || got.sha256 !== f.sha256) throw new Error(`The backup is damaged: the file ${f.key} does not match its checksum.`);
  }
  if (manifest.includeFiles && index && index.length !== summary.files.length) {
    throw new Error("The backup is damaged: its file list and its files disagree.");
  }

  return {
    manifest,
    summary,
    tableCounts: summary.tableCounts,
    fileCount: summary.files.length,
    fileBytes: summary.files.reduce((n, f) => n + f.size, 0),
  };
}
