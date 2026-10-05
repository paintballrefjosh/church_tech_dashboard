import { createHash, type Hash } from "node:crypto";
import { PassThrough, Transform, type Writable } from "node:stream";
import { pipeline } from "node:stream";
import { createGzip } from "node:zlib";
import { sql } from "drizzle-orm";
import type { BackupProgress } from "@church/shared";
import type { Db } from "../db/db.module";
import { TarWriter } from "./tar";
import { backedUpTables, type TableMeta } from "./backup-schema";
import { tableInfo } from "./table-registry";
import { param, selectList, type Row } from "./row-codec";
import { ARCHIVE_FORMAT, ARCHIVE_VERSION, tablePartName, type FileIndexEntry, type Manifest, type Summary } from "./archive";
import type { ObjectStore } from "./object-store";

/** A table is cut into entries of about this many bytes, so no table is ever held whole in memory. */
export const PART_BYTES = 4 * 1024 * 1024;
const PAGE_ROWS = 500;
const id = (name: string) => sql.identifier(name);

export interface WriteDeps {
  db: Db;
  store: ObjectStore;
  progress?: (p: BackupProgress) => void | Promise<void>;
}

export interface WriteOptions {
  id: string;
  name: string;
  includeFiles: boolean;
  createdBy: string | null;
  appVersion: string | null;
  secretFingerprint: string;
}

export interface WriteResult {
  tableCounts: Record<string, number>;
  fileCount: number;
  fileBytes: number;
  schemaMigrations: number | null;
  missingFiles: string[];
}

/** How many migrations the database has applied: the schema generation a backup belongs to. */
export async function appliedMigrations(db: Db): Promise<number | null> {
  try {
    const res = await db.execute(sql`SELECT count(*) AS n FROM drizzle.__drizzle_migrations`);
    const n = (res.rows[0] as { n?: unknown } | undefined)?.n;
    return n === undefined ? null : Number(n);
  } catch {
    return null;
  }
}

export async function readPage(tx: Pick<Db, "execute">, table: TableMeta, columns: string[], after: Row | null): Promise<Row[]> {
  const byName = new Map(table.columns.map((c) => [c.name, c]));
  const order = sql.join(table.pk.map((c) => id(c)), sql`, `);
  const where = after
    ? sql` WHERE (${order}) > (${sql.join(table.pk.map((c) => param(byName.get(c)!, after[c])), sql`, `)})`
    : sql``;
  const res = await tx.execute(sql`SELECT ${selectList(table, columns)} FROM ${id(table.name)}${where} ORDER BY ${order} LIMIT ${PAGE_ROWS}`);
  return res.rows as Row[];
}

async function* hashing(source: AsyncIterable<Buffer>, hash: Hash): AsyncGenerator<Buffer> {
  for await (const chunk of source) {
    hash.update(chunk);
    yield chunk;
  }
}

/**
 * Write a complete backup, as an uncompressed tar, into `out`. Every table is read inside one
 * read-only transaction, so the tables agree with each other as of a single moment.
 */
export async function writeArchive(deps: WriteDeps, out: Writable, opts: WriteOptions): Promise<WriteResult> {
  const tar = new TarWriter(out);
  const tables = backedUpTables();
  const schemaMigrations = await appliedMigrations(deps.db);
  const tableCounts: Record<string, number> = {};
  const attachmentRows: Array<{ key: string; contentType: string | null }> = [];

  const manifest: Manifest = {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    id: opts.id,
    name: opts.name,
    createdAt: new Date().toISOString(),
    appVersion: opts.appVersion,
    schemaMigrations,
    secretFingerprint: opts.secretFingerprint,
    includeFiles: opts.includeFiles,
    createdBy: opts.createdBy,
    tables: tables.map((t) => ({ name: t.name, columns: t.columns.map((c) => ({ name: c.name, type: c.type })), pk: t.pk })),
  };
  await tar.addBuffer("manifest.json", Buffer.from(JSON.stringify(manifest)));

  await deps.db.transaction(
    async (tx) => {
      await tx.execute(sql`SELECT set_config('TimeZone', 'UTC', true)`);
      for (const [i, table] of tables.entries()) {
        await deps.progress?.({ label: `Reading ${tableInfo(table.name).title.toLowerCase()}`, done: i, total: tables.length });
        const columns = table.columns.map((c) => c.name);
        let part = 1;
        let lines: string[] = [];
        let bytes = 0;
        let count = 0;
        const flush = async () => {
          await tar.addBuffer(tablePartName(table.name, part), Buffer.from(lines.join(""), "utf8"));
          part++;
          lines = [];
          bytes = 0;
        };
        let after: Row | null = null;
        for (;;) {
          const page = await readPage(tx, table, columns, after);
          for (const row of page) {
            const line = `${JSON.stringify(row)}\n`;
            lines.push(line);
            bytes += line.length;
            if (table.name === "attachments") {
              attachmentRows.push({ key: String(row.storage_key), contentType: (row.content_type as string | null) ?? null });
            }
            if (bytes >= PART_BYTES) await flush();
          }
          count += page.length;
          if (page.length < PAGE_ROWS) break;
          after = page[page.length - 1]!;
        }
        // Every table has at least one entry (an empty one for an empty table), so a reader sees it.
        if (lines.length > 0 || part === 1) await flush();
        tableCounts[table.name] = count;
      }
    },
    { isolationLevel: "serializable", accessMode: "read only" },
  );

  const files: Summary["files"] = [];
  const missingFiles: string[] = [];
  let fileBytes = 0;
  if (opts.includeFiles) {
    const index: FileIndexEntry[] = [];
    for (const row of attachmentRows) {
      const stat = await deps.store.stat(row.key);
      if (!stat) missingFiles.push(row.key);
      else index.push({ key: row.key, size: stat.size, contentType: row.contentType });
    }
    await tar.addBuffer("files.json", Buffer.from(JSON.stringify(index)));
    for (const [i, entry] of index.entries()) {
      if (i % 20 === 0) await deps.progress?.({ label: "Copying uploaded files", done: i, total: index.length });
      const hash = createHash("sha256");
      let body;
      try {
        body = await deps.store.get(entry.key);
      } catch (err) {
        // Gone since we looked: nothing has been written for it yet, so leave it out.
        missingFiles.push(entry.key);
        void err;
        continue;
      }
      await tar.addStream(`files/${entry.key}`, entry.size, hashing(body as AsyncIterable<Buffer>, hash));
      files.push({ ...entry, sha256: hash.digest("hex") });
      fileBytes += entry.size;
    }
  }

  const summary: Summary = { tableCounts, files, missingFiles, finishedAt: new Date().toISOString() };
  await tar.addBuffer("summary.json", Buffer.from(JSON.stringify(summary)));
  await tar.finish();
  return { tableCounts, fileCount: files.length, fileBytes, schemaMigrations, missingFiles };
}

export interface StoredBackup extends WriteResult {
  sizeBytes: number;
  sha256: string;
}

/** Write a backup, compress it and upload it to `key`, all as one stream. Removes a partial upload on failure. */
export async function storeBackup(deps: WriteDeps, key: string, opts: WriteOptions): Promise<StoredBackup> {
  const tarOut = new PassThrough();
  const gzip = createGzip({ level: 6 });
  const hash = createHash("sha256");
  let size = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  pipeline(tarOut, gzip, counter, () => undefined);
  const upload = deps.store.put(key, counter, "application/gzip");
  upload.catch(() => undefined);
  try {
    const result = await writeArchive(deps, tarOut, opts);
    tarOut.end();
    await upload;
    return { ...result, sizeBytes: size, sha256: hash.digest("hex") };
  } catch (err) {
    tarOut.destroy(err as Error);
    await upload.catch(() => undefined);
    await deps.store.remove([key]).catch(() => undefined);
    throw err;
  }
}
