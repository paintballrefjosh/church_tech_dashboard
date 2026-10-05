import type { Writable } from "node:stream";

/**
 * A small streaming tar (ustar, with PAX headers for long names). Backups are plain
 * `.tar.gz` files so a person can open one with any archive tool; no tar library was
 * needed and none is installed.
 *
 * Writing needs each entry's size up front, so the backup writer cuts a table into
 * bounded parts instead of buffering a whole table (backup-writer.ts).
 */

const BLOCK = 512;

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, "0") + "\0";
}

function putString(buf: Buffer, offset: number, width: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  bytes.copy(buf, offset, 0, Math.min(bytes.length, width));
}

function header(name: string, size: number, mtimeSec: number, typeflag: "0" | "x"): Buffer {
  const h = Buffer.alloc(BLOCK);
  const nameBytes = Buffer.byteLength(name, "utf8");
  putString(h, 0, 100, nameBytes <= 100 ? name : name.slice(0, 50));
  putString(h, 100, 8, octal(0o644, 8));
  putString(h, 108, 8, octal(0, 8));
  putString(h, 116, 8, octal(0, 8));
  if (size > 0o77777777777) throw new Error(`tar entry too large: ${size} bytes`);
  putString(h, 124, 12, octal(size, 12));
  putString(h, 136, 12, octal(mtimeSec, 12));
  h.fill(0x20, 148, 156); // checksum field counts as spaces while summing
  h[156] = typeflag.charCodeAt(0);
  putString(h, 257, 6, "ustar\0");
  putString(h, 263, 2, "00");
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i]!;
  putString(h, 148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
  return h;
}

/** One PAX record: "<length> <key>=<value>\n" where the length counts itself. */
function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  const bodyLen = Buffer.byteLength(body, "utf8");
  let len = bodyLen + String(bodyLen).length;
  if (String(len).length !== String(bodyLen).length) len = bodyLen + String(len).length;
  return Buffer.from(`${len}${body}`, "utf8");
}

function pad(size: number): Buffer {
  const rem = size % BLOCK;
  return rem === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - rem);
}

/** Writes entries to a Writable, waiting for drain so a slow consumer (the upload) paces the dump. */
export class TarWriter {
  private bytes = 0;

  constructor(private readonly out: Writable) {}

  /** Bytes written to the tar stream so far (before compression). */
  get written(): number {
    return this.bytes;
  }

  private async put(chunk: Buffer): Promise<void> {
    if (chunk.length === 0) return;
    this.bytes += chunk.length;
    if (!this.out.write(chunk)) {
      await new Promise<void>((resolve, reject) => {
        const onDrain = () => {
          cleanup();
          resolve();
        };
        const onError = (err: Error) => {
          cleanup();
          reject(err);
        };
        const cleanup = () => {
          this.out.off("drain", onDrain);
          this.out.off("error", onError);
        };
        this.out.once("drain", onDrain);
        this.out.once("error", onError);
      });
    }
  }

  private async entryHeader(name: string, size: number, mtimeSec: number): Promise<void> {
    if (Buffer.byteLength(name, "utf8") > 100) {
      const rec = paxRecord("path", name);
      await this.put(header("PaxHeader", rec.length, mtimeSec, "x"));
      await this.put(rec);
      await this.put(pad(rec.length));
    }
    await this.put(header(name, size, mtimeSec, "0"));
  }

  async addBuffer(name: string, data: Buffer, mtime = new Date()): Promise<void> {
    await this.entryHeader(name, data.length, Math.floor(mtime.getTime() / 1000));
    await this.put(data);
    await this.put(pad(data.length));
  }

  /** Stream exactly `size` bytes. A source that delivers a different count fails the whole archive. */
  async addStream(name: string, size: number, source: AsyncIterable<Buffer>, mtime = new Date()): Promise<void> {
    await this.entryHeader(name, size, Math.floor(mtime.getTime() / 1000));
    let sent = 0;
    for await (const chunk of source) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      sent += buf.length;
      if (sent > size) throw new Error(`${name}: more data than the ${size} bytes announced`);
      await this.put(buf);
    }
    if (sent !== size) throw new Error(`${name}: ${sent} bytes instead of the ${size} announced`);
    await this.put(pad(size));
  }

  /** The end-of-archive marker: two empty blocks. Does not close the stream. */
  async finish(): Promise<void> {
    await this.put(Buffer.alloc(BLOCK * 2));
  }
}

export interface TarEntry {
  name: string;
  size: number;
  /** The entry's bytes. Read it fully or not at all before asking for the next entry. */
  body(): AsyncGenerator<Buffer>;
  /** The whole entry as one buffer. Only for small entries; refuses anything over `limit`. */
  buffer(limit?: number): Promise<Buffer>;
}

class ByteSource {
  private iterator: AsyncIterator<Buffer>;
  private pending: Buffer = Buffer.alloc(0);
  private ended = false;

  constructor(source: AsyncIterable<Buffer>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  private async fill(): Promise<boolean> {
    if (this.ended) return false;
    const next = await this.iterator.next();
    if (next.done) {
      this.ended = true;
      return false;
    }
    const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value as Uint8Array);
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    return true;
  }

  /** Exactly `n` bytes, or fewer at the end of the input. */
  async read(n: number): Promise<Buffer> {
    while (this.pending.length < n) {
      if (!(await this.fill())) break;
    }
    const out = this.pending.subarray(0, n);
    this.pending = this.pending.subarray(n);
    return out;
  }

  /** Up to `n` bytes in however-large pieces the input arrives, never more than `n` in total. */
  async *stream(n: number): AsyncGenerator<Buffer> {
    let left = n;
    while (left > 0) {
      if (this.pending.length === 0 && !(await this.fill())) throw new Error("tar: the archive ends inside an entry");
      const take = Math.min(left, this.pending.length);
      const piece = this.pending.subarray(0, take);
      this.pending = this.pending.subarray(take);
      left -= take;
      yield piece;
    }
  }

  async skip(n: number): Promise<void> {
    for await (const _ of this.stream(n)) void _;
  }
}

function parseOctal(buf: Buffer, offset: number, width: number): number {
  const text = buf.toString("ascii", offset, offset + width).replace(/\0.*$/, "").trim();
  return text === "" ? 0 : parseInt(text, 8);
}

function cstring(buf: Buffer, offset: number, width: number): string {
  const end = buf.indexOf(0, offset);
  return buf.toString("utf8", offset, end === -1 || end > offset + width ? offset + width : end);
}

function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space === -1) break;
    const len = parseInt(data.toString("ascii", i, space), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = data.toString("utf8", space + 1, i + len - 1); // drop the trailing newline
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += len;
  }
  return out;
}

/**
 * Walk a (decompressed) tar stream entry by entry. Each entry's body must be consumed
 * (or left alone: it is skipped) before the next one is requested.
 */
export async function* readTar(source: AsyncIterable<Buffer>): AsyncGenerator<TarEntry> {
  const input = new ByteSource(source);
  let pax: Record<string, string> = {};
  for (;;) {
    const h = await input.read(BLOCK);
    if (h.length === 0) return;
    if (h.length < BLOCK) throw new Error("tar: truncated header");
    if (h.every((b) => b === 0)) return; // end-of-archive marker

    const storedSum = parseOctal(h, 148, 8);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
    if (sum !== storedSum) throw new Error("tar: header checksum mismatch (the file is damaged or not a tar archive)");

    const size = parseOctal(h, 124, 12);
    const type = String.fromCharCode(h[156] === 0 ? 0x30 : h[156]!);
    const prefix = cstring(h, 345, 155);
    const baseName = cstring(h, 0, 100);

    if (type === "x" || type === "g") {
      const data = await input.read(size);
      await input.skip(pad(size).length);
      if (type === "x") pax = { ...pax, ...parsePax(data) };
      continue;
    }

    const name = pax.path ?? (prefix ? `${prefix}/${baseName}` : baseName);
    pax = {};
    if (type !== "0") {
      // Directories, links and the like are not part of a backup: step over them.
      await input.skip(size + pad(size).length);
      continue;
    }

    let consumed = false;
    const entry: TarEntry = {
      name,
      size,
      async *body() {
        if (consumed) throw new Error("tar: entry body already read");
        consumed = true;
        yield* input.stream(size);
        await input.skip(pad(size).length);
      },
      async buffer(limit = 64 * 1024 * 1024) {
        if (size > limit) throw new Error(`tar: ${name} is ${size} bytes, over the ${limit} byte limit`);
        const parts: Buffer[] = [];
        for await (const c of entry.body()) parts.push(c);
        return Buffer.concat(parts);
      },
    };
    yield entry;
    if (!consumed) {
      consumed = true;
      await input.skip(size + pad(size).length);
    }
  }
}
