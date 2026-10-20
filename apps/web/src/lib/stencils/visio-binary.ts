/**
 * Pictures out of a binary Visio file (.vsd drawing, .vss stencil; Visio 2003 and the older v6 layout).
 *
 * The file is a compound document with one stream, `VisioDocument`. It begins with a pointer (type, offset, length,
 * format) at byte 0x24 to a table of more pointers; each pointer names a block of the stream, LZ-compressed when bit 1
 * of its format is set, and most blocks list further pointers (at an offset kept in their own second word) down to the
 * leaves. A stencil's masters hang off the block of type 0x1d, one pointer of type 0x1e per master. A master's art is an
 * enhanced metafile kept whole in a leaf block, so it is found by its own header; the master's name and description
 * are text in its shape and prompt blocks (UTF-16 in Visio 2003 files, single-byte in the older layout).
 *
 * Checked against libvisio on the eleven Cisco stencils: every picture libvisio writes out is found byte for byte.
 */
import { isOle, readOle } from "./ole";
import { visioDecompress } from "./lzss";
import { readEmfHeader } from "./emf";
import { StencilError, type ReadResult, type StencilPicture } from "./types";

interface Pointer {
  type: number;
  offset: number;
  length: number;
  format: number;
}

const MAX_STREAMS = 100_000;
const MAX_BLOCK = 256 * 1024 * 1024;
const MAX_DECODED_TOTAL = 3 * 1024 * 1024 * 1024;

function readPointer(dv: DataView, at: number): Pointer {
  return {
    type: dv.getUint32(at, true),
    offset: dv.getUint32(at + 8, true),
    length: dv.getUint32(at + 12, true),
    format: dv.getUint16(at + 16, true),
  };
}

/** Every EMF whole inside a decoded block (found by its header: type 1 at the start, " EMF" at byte 40, its own length at 48). */
export function carveEmfs(d: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  let from = 0;
  for (;;) {
    const i = findSignature(d, from);
    if (i < 0) break;
    from = i + 4;
    const s = i - 40;
    if (s < 0 || dv.getUint32(s, true) !== 1) continue;
    const total = dv.getUint32(s + 48, true);
    if (total < 100 || s + total > d.length) continue;
    const piece = d.subarray(s, s + total);
    if (readEmfHeader(piece)) out.push(piece);
  }
  return out;
}

function findSignature(d: Uint8Array, from: number): number {
  // " EMF" = 20 45 4d 46
  for (let i = d.indexOf(0x20, from); i >= 0 && i + 3 < d.length; i = d.indexOf(0x20, i + 1)) {
    if (d[i + 1] === 0x45 && d[i + 2] === 0x4d && d[i + 3] === 0x46) return i;
  }
  return -1;
}

/** Runs of printable text: UTF-16 (four letters or more) and single-byte (five or more). */
export function textRuns(d: Uint8Array): string[] {
  const out: string[] = [];
  let i = 0;
  while (i + 1 < d.length) {
    let j = i;
    let s = "";
    while (j + 1 < d.length && d[j]! >= 0x20 && d[j]! < 0x7f && d[j + 1] === 0) {
      s += String.fromCharCode(d[j]!);
      j += 2;
    }
    if (s.length >= 4) {
      out.push(s);
      i = j;
    } else {
      i++;
    }
  }
  let run = "";
  for (let k = 0; k < d.length; k++) {
    const c = d[k]!;
    if (c >= 0x20 && c < 0x7f) run += String.fromCharCode(c);
    else {
      if (run.length >= 5) out.push(run);
      run = "";
    }
  }
  if (run.length >= 5) out.push(run);
  return out;
}

/**
 * Single-byte strings in the older layout start with their own length as a character ("S" or "o" before the text, and
 * sometimes one more byte before that). When a leading character's code is the length of what follows, it is that.
 */
export function dropLengthPrefix(text: string): string {
  for (let k = 0; k < 3 && k < text.length; k++) {
    if (text.charCodeAt(k) === text.length - k - 1) return text.slice(k + 1);
  }
  return text;
}

/** A master's product id from text like "WS-C3850-24: Stackable 24 ...", dropping the stray byte(s) some files put first. */
export function productId(raw: string): string | null {
  const text = dropLengthPrefix(raw);
  const colon = text.indexOf(": ");
  if (colon < 3) return null;
  let id = text.slice(0, colon).replace(/^[^A-Za-z0-9]+/, "");
  if (/^[a-z][A-Z0-9]/.test(id)) id = id.slice(1);
  id = id.trim();
  return id.length >= 3 && id.length <= 80 ? id : null;
}

interface MasterInfo {
  n: number;
  description: string | null;
  id: string | null;
}

export function readVisioBinary(file: Uint8Array, sourceName: string): ReadResult {
  if (!isOle(file)) throw new StencilError("This is not a Visio file.");
  const stream = readOle(file).read("VisioDocument");
  if (!stream || stream.length < 0x40) throw new StencilError("This file has no Visio drawing in it.");
  const head = String.fromCharCode(...stream.subarray(0, 18));
  if (head !== "Visio (TM) Drawing") throw new StencilError("This is not a Visio drawing or stencil.");
  const version = stream[0x1a]!;
  if (version !== 6 && version !== 11) {
    throw new StencilError(`This Visio file is version ${version}, which cannot be read (versions 6 and 11, saved as .vsd/.vss, can).`);
  }
  const dv = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  const size = stream.length;

  function decode(p: Pointer): Uint8Array {
    if (p.length > MAX_BLOCK || p.offset + p.length > size) return new Uint8Array(0);
    const raw = stream!.subarray(p.offset, p.offset + p.length);
    return p.format & 2 ? visioDecompress(raw, MAX_BLOCK) : raw;
  }

  /** The pointers a block lists, if it is a pointer list: its second word is where the list is, minus 4. */
  function children(d: Uint8Array): Pointer[] {
    if (d.length < 16) return [];
    const ddv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    const base = ddv.getUint32(4, true) + 4;
    if (base + 8 > d.length) return [];
    const count = ddv.getUint32(base, true);
    if (count === 0 || count > 20000 || base + 8 + count * 18 > d.length) return [];
    const out: Pointer[] = [];
    for (let i = 0; i < count; i++) {
      const p = readPointer(ddv, base + 8 + i * 18);
      if (p.length === 0) continue;
      if (p.offset + p.length > size || (p.format & 0x0f) > 7 || p.type > 0xff) return []; // not a pointer list after all
      out.push(p);
    }
    return out;
  }

  const top = readPointer(dv, 0x24);
  if (top.length === 0 || top.offset + top.length > size) throw new StencilError("This Visio file's index is damaged.");

  interface Work {
    p: Pointer;
    master: MasterInfo | null;
  }
  const seen = new Set<string>([`${top.offset}:${top.length}`]);
  const queue: Work[] = [{ p: top, master: null }];
  const found: Array<{ bytes: Uint8Array; master: MasterInfo | null }> = [];
  let masterCount = 0;
  let decodedTotal = 0;
  for (let q = 0; q < queue.length; q++) {
    if (queue.length > MAX_STREAMS) throw new StencilError("This Visio file has more parts than can be read.");
    const { p, master } = queue[q]!;
    const d = decode(p);
    decodedTotal += d.length;
    if (decodedTotal > MAX_DECODED_TOTAL) throw new StencilError("This Visio file inflates to more than can be read.");
    const emfs = carveEmfs(d);
    for (const e of emfs) found.push({ bytes: e.slice(), master });
    if (emfs.length === 0 && master) {
      // text that names the master: a short description in a type 0x0a block, "ID: description" in its shape (0x47)
      if (p.type === 0x0a && !master.description) {
        const t = textRuns(d).map(dropLengthPrefix).find((s) => /[A-Za-z]{3}/.test(s) && !/^Copyright/i.test(s.trim()));
        if (t) master.description = t.trim();
      } else if (p.type === 0x47 && !master.id) {
        for (const t of textRuns(d)) {
          const id = productId(t);
          if (id) {
            master.id = id;
            break;
          }
        }
      }
    }
    for (const c of children(d)) {
      const key = `${c.offset}:${c.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let m = master;
      if (c.type === 0x1e && !m) m = { n: ++masterCount, description: null, id: null };
      queue.push({ p: c, master: m });
    }
  }

  const pictures: StencilPicture[] = found.map((f, i) => {
    const name = f.master?.id ?? f.master?.description ?? null;
    return {
      id: `${sourceName}#${i + 1}`,
      kind: "emf" as const,
      bytes: f.bytes,
      name,
      description: f.master?.id && f.master.description ? f.master.description : null,
      source: f.master ? `${sourceName}, master ${f.master.n}` : sourceName,
    };
  });
  const notes: string[] = [];
  if (pictures.length === 0) notes.push(`No pictures were found in ${sourceName}. It may hold only drawn shapes, which cannot be turned into a picture here.`);
  return { pictures, notes };
}
