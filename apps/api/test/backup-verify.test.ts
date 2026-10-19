import { describe, expect, it } from "vitest";
import { PassThrough, Readable } from "node:stream";
import { createGzip } from "node:zlib";
import { createHash, randomUUID } from "node:crypto";
import { TarWriter } from "../src/backup/tar";
import { ARCHIVE_FORMAT, ARCHIVE_VERSION, tablePartName, type Manifest, type Summary } from "../src/backup/archive";
import { backedUpTables, tableMeta } from "../src/backup/backup-schema";
import { verifyStoredArchive } from "../src/backup/backup-verify";
import type { Row } from "../src/backup/row-codec";

/** A complete row for a table: every required column filled with something of the right type. */
function fill(table: string, over: Row = {}): Row {
  const meta = tableMeta(table)!;
  const row: Row = {};
  for (const c of meta.columns) {
    if (c.type === "uuid") row[c.name] = randomUUID();
    else if (c.type.startsWith("timestamp")) row[c.name] = "2026-01-01 00:00:00+00";
    else if (c.type === "boolean") row[c.name] = false;
    else if (c.type === "integer" || c.type === "bigint") row[c.name] = 0;
    else if (c.type === "jsonb" || c.type === "json") row[c.name] = {};
    else if (c.type.endsWith("[]")) row[c.name] = [];
    else row[c.name] = c.notNull ? `${table}.${c.name}` : null;
  }
  return { ...row, ...over };
}

interface Build {
  rows?: Record<string, Row[]>;
  /** Override what the summary claims, to damage the file's own bookkeeping. */
  counts?: Record<string, number>;
}

async function archive(build: Build = {}): Promise<Buffer> {
  const tables = backedUpTables();
  const out = new PassThrough();
  const gzip = createGzip();
  const parts: Buffer[] = [];
  gzip.on("data", (c: Buffer) => parts.push(c));
  out.pipe(gzip);
  const tar = new TarWriter(out);
  const manifest: Manifest = {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    id: randomUUID(),
    name: "test",
    createdAt: new Date().toISOString(),
    appVersion: null,
    schemaMigrations: null,
    secretFingerprint: "x",
    includeFiles: true,
    createdBy: null,
    tables: tables.map((t) => ({ name: t.name, columns: t.columns.map((c) => ({ name: c.name, type: c.type })), pk: t.pk })),
  };
  await tar.addBuffer("manifest.json", Buffer.from(JSON.stringify(manifest)));
  const counts: Record<string, number> = {};
  for (const t of tables) {
    const rows = build.rows?.[t.name] ?? [];
    counts[t.name] = rows.length;
    await tar.addBuffer(tablePartName(t.name, 1), Buffer.from(rows.map((r) => `${JSON.stringify(r)}\n`).join("")));
  }
  await tar.addBuffer("files.json", Buffer.from("[]"));
  const summary: Summary = { tableCounts: { ...counts, ...(build.counts ?? {}) }, files: [], missingFiles: [], finishedAt: new Date().toISOString() };
  await tar.addBuffer("summary.json", Buffer.from(JSON.stringify(summary)));
  await tar.finish();
  out.end();
  await new Promise((r) => gzip.on("end", r));
  return Buffer.concat(parts);
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const open = (b: Buffer) => async () => Readable.from([b.subarray(0, 4000), b.subarray(4000)]);
const check = (b: Buffer, expected: { sha256?: string | null; sizeBytes?: number | null } = {}) =>
  verifyStoredArchive(open(b), { sha256: expected.sha256 === undefined ? sha(b) : expected.sha256, sizeBytes: expected.sizeBytes === undefined ? b.length : expected.sizeBytes });

describe("checking a stored backup", () => {
  it("passes an intact archive and counts what it read", async () => {
    const user = fill("users");
    const group = fill("groups");
    const b = await archive({
      rows: { users: [user], groups: [group], group_memberships: [fill("group_memberships", { user_id: user.id, group_id: group.id })] },
    });
    const r = await check(b);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.rows).toBe(3);
    expect(r.bytes).toBe(b.length);
  });

  it("fails when the file is not the one that was written (checksum or size)", async () => {
    const b = await archive();
    expect((await check(b, { sha256: "0".repeat(64) })).problems[0]).toMatch(/checksum/);
    expect((await check(b, { sizeBytes: b.length + 1 })).problems[0]).toMatch(/bytes/);
  });

  it("fails on a file that was cut short", async () => {
    const b = await archive();
    const r = await check(b.subarray(0, Math.floor(b.length / 2)));
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/complete|valid|damaged|incomplete/i);
  });

  it("fails when a table has other rows than its summary says", async () => {
    const r = await check(await archive({ rows: { groups: [fill("groups")] }, counts: { groups: 2 } }));
    expect(r.problems.join(" ")).toMatch(/groups should have 2 rows but has 1/);
  });

  it("finds a row pointing at a parent that is not in the backup", async () => {
    const user = fill("users");
    const b = await archive({ rows: { users: [user], group_memberships: [fill("group_memberships", { user_id: user.id, group_id: randomUUID() })] } });
    const r = await check(b);
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/group_memberships row .* points to a row in groups/);
  });

  it("finds a key used twice and a required value missing", async () => {
    const g = fill("groups");
    const dup = await check(await archive({ rows: { groups: [g, { ...g }] } }));
    expect(dup.problems.join(" ")).toMatch(/groups has the same key twice/);
    const empty = await check(await archive({ rows: { groups: [fill("groups", { name: null })] } }));
    expect(empty.problems.join(" ")).toMatch(/no value for name/);
  });

  it("accepts an empty optional link and a self-reference to a row later in the table", async () => {
    // wiki_folders points at its parent folder; the child is written before its parent here on purpose.
    const parent = fill("wiki_folders", { parent_folder_id: null });
    const child = fill("wiki_folders", { parent_folder_id: parent.id });
    const r = await check(await archive({ rows: { wiki_folders: [child, parent] } }));
    expect(r.problems).toEqual([]);
    const lost = fill("wiki_folders", { parent_folder_id: randomUUID() });
    expect((await check(await archive({ rows: { wiki_folders: [lost] } }))).problems.join(" ")).toMatch(/wiki_folders row .* points to a row in wiki_folders/);
  });

  it("reports a store that cannot be read as a problem, not a crash", async () => {
    const r = await verifyStoredArchive(async () => {
      throw new Error("connection refused");
    }, { sha256: null, sizeBytes: null });
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/could not be read: connection refused/);
  });
});
