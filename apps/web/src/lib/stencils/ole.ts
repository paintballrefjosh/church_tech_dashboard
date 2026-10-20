/**
 * A reader for OLE2 compound files (the container of .ppt, .doc, .xls and binary Visio .vsd/.vss files): the streams
 * inside, by name. Read only, and defensive: a damaged or hostile file gives an error or a missing stream, never a loop
 * or an enormous allocation.
 */

export interface OleStream {
  name: string;
  size: number;
}

export interface OleFile {
  streams: OleStream[];
  /** The bytes of a stream by name (the first one of that name, anywhere in the file), or null. */
  read(name: string): Uint8Array | null;
}

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const END_OF_CHAIN = 0xfffffffe;
const FREE = 0xffffffff;
const MAX_STREAM = 1024 * 1024 * 1024;

export function isOle(buf: Uint8Array): boolean {
  return buf.length >= 512 && SIGNATURE.every((b, i) => buf[i] === b);
}

export function readOle(buf: Uint8Array): OleFile {
  if (!isOle(buf)) throw new Error("This is not an OLE compound file.");
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const sectorShift = dv.getUint16(30, true);
  const miniShift = dv.getUint16(32, true);
  if (sectorShift !== 9 && sectorShift !== 12) throw new Error("Unsupported sector size.");
  const sectorSize = 1 << sectorShift;
  const miniSize = 1 << miniShift;
  // the header takes the first sector's place (512 bytes, or a whole 4096-byte sector in version 4 files)
  const at = (s: number) => sectorSize + s * sectorSize;

  const fatSectorCount = dv.getUint32(44, true);
  const firstDir = dv.getUint32(48, true);
  const miniCutoff = dv.getUint32(56, true);
  const firstMiniFat = dv.getUint32(60, true);
  const miniFatCount = dv.getUint32(64, true);
  let difat = dv.getUint32(68, true);
  const difatCount = dv.getUint32(72, true);

  const inFile = (s: number) => at(s) < buf.length;

  // the FAT: which sector follows which
  const fatSectors: number[] = [];
  for (let i = 0; i < 109 && fatSectors.length < fatSectorCount; i++) {
    const s = dv.getUint32(76 + i * 4, true);
    if (s !== FREE) fatSectors.push(s);
  }
  for (let d = 0; d < difatCount && difat !== END_OF_CHAIN && difat !== FREE && fatSectors.length < fatSectorCount; d++) {
    if (!inFile(difat)) break;
    const o = at(difat);
    for (let i = 0; i < sectorSize / 4 - 1 && fatSectors.length < fatSectorCount; i++) {
      const s = dv.getUint32(o + i * 4, true);
      if (s !== FREE) fatSectors.push(s);
    }
    difat = dv.getUint32(o + sectorSize - 4, true);
  }
  const fat: number[] = [];
  for (const s of fatSectors) {
    if (!inFile(s)) continue;
    const o = at(s);
    for (let i = 0; i < sectorSize / 4; i++) fat.push(dv.getUint32(o + i * 4, true));
  }

  function chain(start: number, limit = Infinity): number[] {
    const out: number[] = [];
    let s = start;
    while (s !== END_OF_CHAIN && s !== FREE && out.length < Math.min(fat.length, limit)) {
      if (s >= fat.length || !inFile(s)) break;
      out.push(s);
      s = fat[s]!;
    }
    return out;
  }

  function readChain(start: number, size: number): Uint8Array {
    const sectors = chain(start, Math.ceil(size / sectorSize));
    const out = new Uint8Array(Math.min(size, sectors.length * sectorSize));
    for (let i = 0; i < sectors.length; i++) {
      const from = at(sectors[i]!);
      const len = Math.min(sectorSize, out.length - i * sectorSize, buf.length - from);
      if (len <= 0) break;
      out.set(buf.subarray(from, from + len), i * sectorSize);
    }
    return out;
  }

  // directory entries (128 bytes each)
  const dirBytes = readChain(firstDir, Math.min(MAX_STREAM, (fat.length || 1) * sectorSize));
  const dirDv = new DataView(dirBytes.buffer, dirBytes.byteOffset, dirBytes.byteLength);
  interface Entry {
    name: string;
    type: number;
    start: number;
    size: number;
  }
  const entries: Entry[] = [];
  for (let o = 0; o + 128 <= dirBytes.length; o += 128) {
    const nameLen = dirDv.getUint16(o + 64, true);
    let name = "";
    for (let i = 0; i < Math.min(nameLen, 64) / 2 - 1; i++) name += String.fromCharCode(dirDv.getUint16(o + i * 2, true));
    const type = dirBytes[o + 66]!;
    // the size is 64 bits in version 4 files and 32 bits (plus junk) in version 3
    const lo = dirDv.getUint32(o + 120, true);
    const hi = dirDv.getUint32(o + 124, true);
    const size = sectorSize === 4096 ? hi * 4294967296 + lo : lo;
    entries.push({ name, type, start: dirDv.getUint32(o + 116, true), size });
  }
  const root = entries.find((e) => e.type === 5);

  // the mini stream: small streams live packed inside the root entry's own stream
  let miniFat: number[] | null = null;
  let miniStream: Uint8Array | null = null;
  function ensureMini() {
    if (miniFat && miniStream) return;
    miniFat = [];
    const mf = readChain(firstMiniFat, Math.max(1, miniFatCount) * sectorSize);
    const mdv = new DataView(mf.buffer, mf.byteOffset, mf.byteLength);
    for (let i = 0; i + 4 <= mf.length; i += 4) miniFat.push(mdv.getUint32(i, true));
    miniStream = root ? readChain(root.start, Math.min(root.size, MAX_STREAM)) : new Uint8Array(0);
  }

  function readEntry(e: Entry): Uint8Array {
    if (e.size > MAX_STREAM) throw new Error("A stream in this file is too large to read.");
    if (e.size >= miniCutoff) return readChain(e.start, e.size);
    ensureMini();
    const out = new Uint8Array(e.size);
    let s = e.start;
    let n = 0;
    let guard = 0;
    while (s !== END_OF_CHAIN && s !== FREE && n < e.size && guard++ <= miniFat!.length) {
      const from = s * miniSize;
      const len = Math.min(miniSize, e.size - n, miniStream!.length - from);
      if (len <= 0) break;
      out.set(miniStream!.subarray(from, from + len), n);
      n += len;
      s = miniFat![s] ?? END_OF_CHAIN;
    }
    return out;
  }

  const streams = entries.filter((e) => e.type === 2).map((e) => ({ name: e.name, size: e.size }));
  return {
    streams,
    read(name: string) {
      const e = entries.find((x) => x.type === 2 && x.name === name);
      return e ? readEntry(e) : null;
    },
  };
}
