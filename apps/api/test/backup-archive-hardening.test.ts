import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { Readable, Writable } from "node:stream";
import { ARCHIVE_FORMAT, ARCHIVE_VERSION, gunzipped, isSafeFileKey, readArchive } from "../src/backup/archive";
import { inspectArchive } from "../src/backup/backup-inspect";
import { MAX_PAX_BYTES, TarWriter, readTar } from "../src/backup/tar";

const BLOCK = 512;

/** A raw tar header with whatever size text we like, so a hostile or damaged one can be made. */
function rawHeader(name: string, sizeField: string, type = "0"): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0);
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(sizeField.padEnd(12, "\0"), 124);
  h.write("00000000000\0", 136);
  h.fill(0x20, 148, 156);
  h[156] = type.charCodeAt(0);
  h.write("ustar\0", 257);
  h.write("00", 263);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i]!;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}
const octal12 = (n: number) => n.toString(8).padStart(11, "0") + "\0";

async function tarOf(fill: (w: TarWriter) => Promise<void>): Promise<Buffer> {
  const parts: Buffer[] = [];
  const sink = new Writable({ write(chunk: Buffer, _e, cb) { parts.push(chunk); cb(); } });
  const w = new TarWriter(sink);
  await fill(w);
  await w.finish();
  return Buffer.concat(parts);
}
const source = (b: Buffer) => Readable.from([b]);

const manifest = { format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION, id: "x", name: "t", createdAt: "2026-01-01T00:00:00Z", appVersion: null, schemaMigrations: 1, secretFingerprint: "f", includeFiles: true, createdBy: null, tables: [] };
const summary = { tableCounts: {}, files: [], missingFiles: [], finishedAt: "2026-01-01T00:00:00Z" };
const json = (v: unknown) => Buffer.from(JSON.stringify(v));

async function drain(it: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of it) void _;
}

describe("readTar against hostile headers", () => {
  it("refuses an extended header that announces far more than any real one, at once", async () => {
    const hostile = Buffer.concat([rawHeader("PaxHeader", octal12(64 * 1024 * 1024), "x"), Buffer.alloc(BLOCK * 4)]);
    const started = Date.now();
    await expect(drain(readTar(source(hostile)))).rejects.toThrow(/extended header is far larger/);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(MAX_PAX_BYTES).toBeLessThanOrEqual(1024 * 1024);
  });

  it("refuses a size that is not a number, or negative", async () => {
    for (const field of ["zzzzzzzzzzz\0", "-0000000001\0"]) {
      await expect(drain(readTar(source(Buffer.concat([rawHeader("a.txt", field), Buffer.alloc(BLOCK)]))))).rejects.toThrow(/impossible size/);
    }
  });

  it("still reads a long path (a real extended header) back", async () => {
    const name = `tables/${"x".repeat(150)}/000001.ndjson`;
    const tar = await tarOf((w) => w.addBuffer(name, Buffer.from("hello")));
    const seen: string[] = [];
    for await (const e of readTar(source(tar))) seen.push(`${e.name}:${(await e.buffer()).toString()}`);
    expect(seen).toEqual([`${name}:hello`]);
  });
});

describe("isSafeFileKey", () => {
  it("accepts the keys the app writes", () => {
    for (const k of ["attachments/note/6b1f2f9e-0000-4000-8000-000000000000.png", "attachments/wiki_page/a-b.c.docx", "attachments/x/y z.txt"]) {
      expect(isSafeFileKey(k)).toBe(true);
    }
  });

  it("refuses anything outside the uploads folder or able to climb out of it", () => {
    for (const k of [
      "backups/2026-01-01.tar.gz",
      "attachments",
      "attachments/",
      "/attachments/a",
      "attachments/../backups/x.tar.gz",
      "attachments/./a",
      "attachments/a/../../b",
      "attachments\\a",
      "attachments/a\u0000b",
      "attachments/a\nb",
      `attachments/${"a".repeat(1100)}`,
      "other/attachments/a",
      "",
    ]) {
      expect(isSafeFileKey(k), JSON.stringify(k)).toBe(false);
    }
    expect(isSafeFileKey(undefined)).toBe(false);
    expect(isSafeFileKey(42)).toBe(false);
  });
});

describe("readArchive refuses what a restore must never act on", () => {
  it("a file entry outside the uploads folder (it would overwrite a stored backup)", async () => {
    const tar = await tarOf(async (w) => {
      await w.addBuffer("manifest.json", json(manifest));
      await w.addBuffer("files/backups/pre-restore.tar.gz", Buffer.from("not yours"));
    });
    await expect(drain(readArchive(source(tar)))).rejects.toThrow(/outside the uploads folder/);
  });

  it("a file list that names such a key, or is not a list", async () => {
    for (const files of [[{ key: "attachments/../backups/x", size: 1, contentType: null }], [{ key: "backups/x", size: 1, contentType: null }], { not: "a list" }, [{ key: "attachments/a", size: "big" }]]) {
      const tar = await tarOf(async (w) => {
        await w.addBuffer("manifest.json", json(manifest));
        await w.addBuffer("files.json", json(files));
      });
      await expect(drain(readArchive(source(tar)))).rejects.toThrow();
    }
  });

  it("a summary without its parts, and a manifest that lists no tables", async () => {
    const noSummaryParts = await tarOf(async (w) => {
      await w.addBuffer("manifest.json", json(manifest));
      await w.addBuffer("summary.json", json({ finishedAt: "x" }));
    });
    await expect(drain(readArchive(source(noSummaryParts)))).rejects.toThrow(/summary is incomplete/);
    const noTables = await tarOf((w) => w.addBuffer("manifest.json", json({ ...manifest, tables: undefined })));
    await expect(drain(readArchive(source(noTables)))).rejects.toThrow(/does not list the tables/);
  });

  it("a table folder name that is not valid, in plain words", async () => {
    const tar = await tarOf(async (w) => {
      await w.addBuffer("manifest.json", json(manifest));
      await w.addBuffer("tables/%E0%A4%A/000001.ndjson", Buffer.from(""));
    });
    await expect(drain(readArchive(source(tar)))).rejects.toThrow(/table folder has a name that is not valid/);
  });

  it("still accepts a well-formed archive with a file", async () => {
    const bytes = Buffer.from("png-bytes");
    const sha = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
    const key = "attachments/note/abc.png";
    const tar = await tarOf(async (w) => {
      await w.addBuffer("manifest.json", json(manifest));
      await w.addBuffer("files.json", json([{ key, size: bytes.length, contentType: "image/png" }]));
      await w.addBuffer(`files/${key}`, bytes);
      await w.addBuffer("summary.json", json({ ...summary, files: [{ key, size: bytes.length, contentType: "image/png", sha256: sha }] }));
    });
    const info = await inspectArchive(source(tar));
    expect(info.fileCount).toBe(1);
  });

  it("explains damaged JSON in plain words", async () => {
    const tar = await tarOf((w) => w.addBuffer("manifest.json", Buffer.from("{not json")));
    await expect(inspectArchive(source(tar))).rejects.toThrow(/The backup is damaged: part of it is not valid data/);
  });
});

describe("gunzipped expansion guard", () => {
  it("stops a file that expands far beyond what a backup can", async () => {
    const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024), { level: 9 }); // ~64 KB for 64 MiB
    const out = gunzipped(Readable.from([bomb]), { freeBytes: 4 * 1024 * 1024, maxRatio: 50 });
    await expect(drain(out)).rejects.toThrow(/expands far more than a real backup can/);
  });

  it("lets ordinary data through, and a high ratio below the free allowance", async () => {
    const text = Buffer.from("row ".repeat(250_000)); // 1 MB, compresses a lot, but stays under freeBytes
    const out = gunzipped(Readable.from([gzipSync(text)]), { freeBytes: 4 * 1024 * 1024, maxRatio: 50 });
    let n = 0;
    for await (const c of out) n += (c as Buffer).length;
    expect(n).toBe(text.length);
  });
});
