/**
 * Builders for small synthetic files, so the stencil readers are tested without committing any vendor's artwork: an OLE
 * compound file, a zip, an EMF, and a binary Visio file with one master. Test use only.
 */
import { deflateRawSync, deflateSync } from "node:zlib";

export function bytes(...parts: Array<number[] | Uint8Array>): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function u16(n: number): number[] {
  return [n & 255, (n >> 8) & 255];
}
export function u32(n: number): number[] {
  return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
}
export function utf16(s: string): number[] {
  return [...s].flatMap((c) => u16(c.charCodeAt(0)));
}

// ---- EMF ----

/** A tiny valid EMF: a header, the given records, and an EOF. */
export function buildEmf(records: Uint8Array[] = [], bounds: [number, number, number, number] = [0, 0, 99, 49]): Uint8Array {
  const eof = bytes(u32(14), u32(20), u32(0), u32(16), u32(20));
  const body = bytes(...records, eof);
  const header = new Uint8Array(88);
  const dv = new DataView(header.buffer);
  dv.setUint32(0, 1, true);
  dv.setUint32(4, 88, true);
  bounds.forEach((v, i) => dv.setInt32(8 + i * 4, v, true));
  dv.setInt32(24, 0, true);
  dv.setInt32(28, 0, true);
  dv.setInt32(32, 9900, true);
  dv.setInt32(36, 4900, true);
  dv.setUint32(40, 0x464d4520, true);
  dv.setUint32(44, 0x10000, true);
  dv.setUint32(48, 88 + body.length, true);
  dv.setUint32(52, 2 + records.length, true);
  dv.setUint16(56, 1, true);
  return bytes(header, body);
}

export function emfRecord(type: number, payload: number[] = []): Uint8Array {
  const padded = payload.length % 4 === 0 ? payload : [...payload, ...new Array(4 - (payload.length % 4)).fill(0)];
  return bytes(u32(type), u32(8 + padded.length), padded);
}

export function f32(n: number): number[] {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, n, true);
  return [...b];
}

// ---- OLE compound file ----

/** A version 3 compound file (512-byte sectors): streams under 4096 bytes go in the mini stream, the rest in sectors. */
export function buildOle(streams: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const SECTOR = 512;
  const MINI = 64;
  const END = 0xfffffffe;
  const small = streams.filter((s) => s.data.length < 4096);
  const large = streams.filter((s) => s.data.length >= 4096);

  // mini stream and its FAT
  const miniFat: number[] = [];
  const miniChunks: Uint8Array[] = [];
  const miniStart = new Map<string, number>();
  for (const s of small) {
    const count = Math.max(1, Math.ceil(s.data.length / MINI));
    miniStart.set(s.name, miniFat.length);
    for (let i = 0; i < count; i++) miniFat.push(i === count - 1 ? END : miniFat.length + 1);
    const padded = new Uint8Array(count * MINI);
    padded.set(s.data);
    miniChunks.push(padded);
  }
  const miniStream = bytes(...miniChunks);

  const sectorsFor = (len: number) => Math.max(1, Math.ceil(len / SECTOR));
  const dirEntries = streams.length + 1;
  const dirSectors = Math.ceil(dirEntries / 4);
  const miniFatSectors = miniFat.length ? Math.ceil((miniFat.length * 4) / SECTOR) : 0;
  const miniStreamSectors = miniStream.length ? sectorsFor(miniStream.length) : 0;
  const largeSectors = large.map((s) => sectorsFor(s.data.length));

  // sector numbers: 0 = FAT, then directory, mini FAT, mini stream, large streams
  let next = 1;
  const dirStart = next;
  next += dirSectors;
  const miniFatStart = miniFatSectors ? next : END;
  next += miniFatSectors;
  const miniStreamStart = miniStreamSectors ? next : END;
  next += miniStreamSectors;
  const largeStart = large.map((_, i) => {
    const s = next;
    next += largeSectors[i]!;
    return s;
  });
  const total = next;
  if (total > 128) throw new Error("test OLE builder: too many sectors for one FAT sector");

  const fat = new Array<number>(128).fill(0xffffffff);
  fat[0] = 0xfffffffd; // the FAT's own sector
  const chain = (start: number, count: number) => {
    for (let i = 0; i < count; i++) fat[start + i] = i === count - 1 ? END : start + i + 1;
  };
  chain(dirStart, dirSectors);
  if (miniFatSectors) chain(miniFatStart, miniFatSectors);
  if (miniStreamSectors) chain(miniStreamStart, miniStreamSectors);
  large.forEach((_, i) => chain(largeStart[i]!, largeSectors[i]!));

  const file = new Uint8Array((1 + total) * SECTOR);
  const dv = new DataView(file.buffer);
  file.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  dv.setUint16(24, 0x3e, true);
  dv.setUint16(26, 3, true);
  dv.setUint16(28, 0xfffe, true);
  dv.setUint16(30, 9, true);
  dv.setUint16(32, 6, true);
  dv.setUint32(44, 1, true); // one FAT sector
  dv.setUint32(48, dirStart, true);
  dv.setUint32(56, 4096, true);
  dv.setUint32(60, miniFatStart, true);
  dv.setUint32(64, miniFatSectors, true);
  dv.setUint32(68, END, true);
  dv.setUint32(72, 0, true);
  for (let i = 0; i < 109; i++) dv.setUint32(76 + i * 4, i === 0 ? 0 : 0xffffffff, true);

  const at = (s: number) => (s + 1) * SECTOR;
  fat.forEach((v, i) => dv.setUint32(at(0) + i * 4, v, true));

  // directory: root, then the streams (a flat list: each is the root's child chain through right siblings)
  const entry = (i: number, name: string, type: number, start: number, size: number, right: number, child: number) => {
    const o = at(dirStart) + i * 128;
    for (let k = 0; k < name.length; k++) dv.setUint16(o + k * 2, name.charCodeAt(k), true);
    dv.setUint16(o + 64, (name.length + 1) * 2, true);
    file[o + 66] = type;
    file[o + 67] = 1;
    dv.setUint32(o + 68, 0xffffffff, true);
    dv.setUint32(o + 72, right, true);
    dv.setUint32(o + 76, child, true);
    dv.setUint32(o + 116, start, true);
    dv.setUint32(o + 120, size, true);
  };
  for (let i = dirEntries; i < dirSectors * 4; i++) {
    const o = at(dirStart) + i * 128;
    dv.setUint32(o + 68, 0xffffffff, true);
    dv.setUint32(o + 72, 0xffffffff, true);
    dv.setUint32(o + 76, 0xffffffff, true);
  }
  entry(0, "Root Entry", 5, miniStreamStart, miniStream.length, 0xffffffff, streams.length ? 1 : 0xffffffff);
  streams.forEach((s, i) => {
    const isSmall = s.data.length < 4096;
    const start = isSmall ? miniStart.get(s.name)! : largeStart[large.indexOf(s)]!;
    entry(i + 1, s.name, 2, start, s.data.length, i + 1 < streams.length ? i + 2 : 0xffffffff, 0xffffffff);
  });

  miniFat.forEach((v, i) => dv.setUint32(at(miniFatStart) + i * 4, v, true));
  file.set(miniStream, at(miniStreamStart === END ? 0 : miniStreamStart));
  large.forEach((s, i) => file.set(s.data, at(largeStart[i]!)));
  return file;
}

// ---- zip ----

export function buildZip(files: Array<{ name: string; data: Uint8Array; store?: boolean; lieAboutSize?: number }>): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = new TextEncoder().encode(f.name);
    const body = f.store ? f.data : new Uint8Array(deflateRawSync(f.data));
    const size = f.lieAboutSize ?? f.data.length;
    const local = bytes(u32(0x04034b50), u16(20), u16(0), u16(f.store ? 0 : 8), u16(0), u16(0), u32(0), u32(body.length), u32(size), u16(name.length), u16(0), [...name], body);
    central.push(bytes(u32(0x02014b50), u16(20), u16(20), u16(0), u16(f.store ? 0 : 8), u16(0), u16(0), u32(0), u32(body.length), u32(size), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), [...name]));
    parts.push(local);
    offset += local.length;
  }
  const dir = bytes(...central);
  return bytes(...parts, dir, u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(dir.length), u32(offset), u16(0));
}

export function zlib(data: Uint8Array): Uint8Array {
  return new Uint8Array(deflateSync(data));
}

// ---- Visio binary ----

/** Visio's compression with literals only (a flag byte of 0xFF per eight bytes): valid input for the decoder. */
export function literalLzss(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < data.length; i += 8) {
    const chunk = data.subarray(i, i + 8);
    out.push((1 << chunk.length) - 1, ...chunk);
  }
  return new Uint8Array(out);
}

interface Block {
  type: number;
  format: number;
  data: Uint8Array;
}

/** A block that lists pointers: [u32][u32 listOffset=8][u32][count][skip][18-byte records] (the list starts at offset + 4). */
export function pointerListData(count: number, records: Uint8Array): Uint8Array {
  return bytes(u32(0), u32(8), u32(0), u32(count), u32(0), records);
}

function pointerRecord(type: number, offset: number, length: number, format: number): Uint8Array {
  return bytes(u32(type), u32(0), u32(offset), u32(length), u16(format));
}

/**
 * A binary Visio stencil with one master: top list -> 0x1d masters list -> a 0x1e master listing its description (0x0a),
 * shape text (0x47) and a 0x4e block that lists the picture (0x0c). Every block is compressed.
 */
export function buildVisioStencil(opts: { id: string; description: string; emf: Uint8Array; utf16?: boolean }): Uint8Array {
  const text = (s: string) => (opts.utf16 === false ? [...s].map((c) => c.charCodeAt(0)) : utf16(s));
  const blocks: Block[] = [];
  let pos = 0x40; // blocks start after the header and the first pointer
  const place = (b: Block) => {
    const raw = literalLzss(b.data);
    blocks.push({ ...b, data: raw });
    const p = { type: b.type, offset: pos, length: raw.length, format: b.format };
    pos += raw.length;
    return p;
  };
  const rec = (p: { type: number; offset: number; length: number; format: number }) => pointerRecord(p.type, p.offset, p.length, p.format);
  const leaf = (payload: number[] | Uint8Array) => bytes(u32(0), u32(0xfffffff0), payload); // second word too big to be a list

  const emfLeaf = place({ type: 0x0c, format: 0x46, data: leaf(opts.emf) });
  const foreign = place({ type: 0x4e, format: 0x52, data: pointerListData(1, rec(emfLeaf)) });
  const desc = place({ type: 0x0a, format: 0x46, data: leaf(text(opts.description)) });
  const shape = place({ type: 0x47, format: 0xd6, data: leaf(text(`${opts.id}: ${opts.description}`)) });
  const master = place({ type: 0x1e, format: 0x53, data: pointerListData(3, bytes(rec(desc), rec(shape), rec(foreign))) });
  const masters = place({ type: 0x1d, format: 0x52, data: pointerListData(1, rec(master)) });
  const top = place({ type: 0x14, format: 0x52, data: pointerListData(1, rec(masters)) });

  const total = pos;
  const file = new Uint8Array(total);
  const dv = new DataView(file.buffer);
  file.set([...("Visio (TM) Drawing\r\n")].map((c) => c.charCodeAt(0)), 0);
  file[0x1a] = 11;
  dv.setUint32(0x1c, total, true);
  file.set(pointerRecord(top.type, top.offset, top.length, top.format), 0x24);
  let at = 0x40;
  for (const b of blocks) {
    file.set(b.data, at);
    at += b.data.length;
  }
  return file;
}
