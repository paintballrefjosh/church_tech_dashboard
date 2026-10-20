/**
 * A small zip reader (read only) for the packages stencils come in: Cisco's download zips, Visio .vsdx/.vssx and
 * PowerPoint .pptx files. Entries are listed from the central directory and inflated one at a time with the browser's
 * own DecompressionStream, with a hard cap on what any one entry may inflate to, so a zip bomb costs an error and not
 * the tab. Encrypted entries and zip64 archives are not supported (and say so).
 */

export interface ZipEntry {
  name: string;
  /** Size the archive says the entry inflates to. */
  size: number;
  compressedSize: number;
  read(): Promise<Uint8Array>;
}

export interface ZipLimits {
  /** Most entries listed. */
  maxEntries: number;
  /** Most bytes any one entry may inflate to. */
  maxEntryBytes: number;
}

const DEFAULT_LIMITS: ZipLimits = { maxEntries: 20000, maxEntryBytes: 512 * 1024 * 1024 };

export function isZip(buf: Uint8Array): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 3 || buf[2] === 5) && (buf[3] === 4 || buf[3] === 6);
}

export function readZip(buf: Uint8Array, limits: Partial<ZipLimits> = {}): ZipEntry[] {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // the end-of-central-directory record is in the last 64 KiB (it can be followed by a comment)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("This is not a zip file (no directory at the end).");
  const total = dv.getUint16(eocd + 10, true);
  const dirSize = dv.getUint32(eocd + 12, true);
  const dirOffset = dv.getUint32(eocd + 16, true);
  if (total === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) throw new Error("Zip64 archives are not supported.");
  if (total > lim.maxEntries) throw new Error(`This zip has ${total} entries, more than the ${lim.maxEntries} that are read.`);
  if (dirOffset + dirSize > buf.length) throw new Error("The zip's directory is damaged.");

  const utf8 = new TextDecoder("utf-8");
  const entries: ZipEntry[] = [];
  let p = dirOffset;
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error("The zip's directory is damaged.");
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const compressedSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = utf8.decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue; // a folder
    entries.push({
      name,
      size,
      compressedSize,
      async read() {
        if (flags & 1) throw new Error(`${name} is encrypted.`);
        if (size > lim.maxEntryBytes) throw new Error(`${name} is larger than the ${Math.round(lim.maxEntryBytes / 1048576)} MiB that is read.`);
        if (localOffset + 30 > buf.length || dv.getUint32(localOffset, true) !== 0x04034b50) throw new Error(`${name} is damaged.`);
        const start = localOffset + 30 + dv.getUint16(localOffset + 26, true) + dv.getUint16(localOffset + 28, true);
        if (start + compressedSize > buf.length) throw new Error(`${name} is cut short.`);
        const data = buf.subarray(start, start + compressedSize);
        if (method === 0) return data.slice();
        if (method !== 8) throw new Error(`${name} uses a compression method (${method}) that is not supported.`);
        return inflateRaw(data, Math.min(lim.maxEntryBytes, size + 1024), name);
      },
    });
  }
  return entries;
}

/** Inflates raw deflate data, stopping with an error if it grows past `limit` (the size the archive declared, plus a little). */
async function inflateRaw(data: Uint8Array, limit: number, name: string): Promise<Uint8Array> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  }).pipeThrough(new DecompressionStream("deflate-raw" as CompressionFormat));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw new Error(`${name} inflates to more than its zip says it should.`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Inflates zlib-wrapped data (a PowerPoint metafile blip), under the same cap. */
export async function inflateZlib(data: Uint8Array, limit: number): Promise<Uint8Array> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  }).pipeThrough(new DecompressionStream("deflate"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw new Error("A picture inflates to more than it should.");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
