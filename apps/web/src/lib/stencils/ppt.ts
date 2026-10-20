/**
 * Pictures out of PowerPoint files: the binary .ppt (a compound file whose `Pictures` stream is a run of Office Art
 * "blip" records) and the zipped .pptx (pictures are plain files under ppt/media). Vendors ship their stencil art as
 * a .ppt beside the Visio stencil, with each device's drawing a metafile on a slide.
 */
import { isOle, readOle } from "./ole";
import { inflateZlib, type ZipEntry } from "./zip";
import { sniffPicture, extensionOf } from "./sniff";
import { StencilError, type PictureKind, type ReadResult, type StencilPicture } from "./types";

interface BlipKind {
  kind: PictureKind;
  /** The record's instance value when it has one picture id, and when it has two (the second adds another 16 bytes). */
  one: number;
  two: number;
  metafile: boolean;
}

// Office Art blip record types (MS-ODRAW 2.2.23 onward)
const BLIPS: Record<number, BlipKind> = {
  0xf01a: { kind: "emf", one: 0x3d4, two: 0x3d5, metafile: true },
  0xf01b: { kind: "wmf", one: 0x216, two: 0x217, metafile: true },
  0xf01c: { kind: "pict", one: 0x542, two: 0x543, metafile: true },
  0xf01d: { kind: "jpeg", one: 0x46a, two: 0x46b, metafile: false },
  0xf01e: { kind: "png", one: 0x6e0, two: 0x6e1, metafile: false },
  0xf01f: { kind: "dib", one: 0x7a8, two: 0x7a9, metafile: false },
  0xf029: { kind: "tiff", one: 0x6e4, two: 0x6e5, metafile: false },
  0xf02a: { kind: "jpeg", one: 0x6e2, two: 0x6e3, metafile: false },
};

const MAX_PICTURE = 256 * 1024 * 1024;

export async function readPowerPointBinary(file: Uint8Array, sourceName: string): Promise<ReadResult> {
  if (!isOle(file)) throw new StencilError("This is not a PowerPoint file.");
  const pics = readOle(file).read("Pictures");
  const notes: string[] = [];
  if (!pics) {
    return { pictures: [], notes: [`${sourceName} has no pictures in it.`] };
  }
  const dv = new DataView(pics.buffer, pics.byteOffset, pics.byteLength);
  const pictures: StencilPicture[] = [];
  let pos = 0;
  let n = 0;
  while (pos + 8 <= pics.length) {
    const verInst = dv.getUint16(pos, true);
    const type = dv.getUint16(pos + 2, true);
    const len = dv.getUint32(pos + 4, true);
    const bodyStart = pos + 8;
    if (bodyStart + len > pics.length) break;
    pos = bodyStart + len;
    const blip = BLIPS[type];
    if (!blip) continue;
    const instance = verInst >> 4;
    const off = 16 + (instance === blip.two ? 16 : 0);
    const body = pics.subarray(bodyStart, bodyStart + len);
    try {
      let bytes: Uint8Array;
      if (blip.metafile) {
        if (off + 34 > body.length) continue;
        const bdv = new DataView(body.buffer, body.byteOffset, body.byteLength);
        const cbSize = bdv.getUint32(off, true);
        const compressed = body[off + 32] === 0;
        const data = body.subarray(off + 34);
        bytes = compressed ? await inflateZlib(data, Math.min(MAX_PICTURE, Math.max(cbSize + 1024, 1024))) : data.slice();
      } else {
        if (off + 1 > body.length) continue;
        bytes = body.slice(off + 1);
      }
      n++;
      pictures.push({ id: `${sourceName}#${n}`, kind: blip.kind, bytes, name: null, description: null, source: `${sourceName}, picture ${n}` });
    } catch (e) {
      notes.push(`A picture in ${sourceName} could not be read: ${(e as Error).message}`);
    }
  }
  if (pictures.length === 0) notes.push(`No pictures were found in ${sourceName}.`);
  return { pictures, notes };
}

/** Pictures from an Open XML package (pptx, docx, xlsx): everything under a `media` folder. */
export async function readOfficeMedia(entries: ZipEntry[], sourceName: string): Promise<ReadResult> {
  const pictures: StencilPicture[] = [];
  const notes: string[] = [];
  let n = 0;
  for (const e of entries) {
    if (!/(^|\/)media\//i.test(e.name)) continue;
    const ext = extensionOf(e.name);
    if (!["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "emf", "wmf", "tif", "tiff"].includes(ext)) continue;
    try {
      const bytes = await e.read();
      const kind = sniffPicture(bytes);
      if (!kind) {
        notes.push(`${e.name} is not a picture this can read.`);
        continue;
      }
      n++;
      pictures.push({ id: `${sourceName}#${n}`, kind, bytes, name: e.name.slice(e.name.lastIndexOf("/") + 1), description: null, source: `${sourceName}, ${e.name}` });
    } catch (err) {
      notes.push(`${e.name} could not be read: ${(err as Error).message}`);
    }
  }
  if (pictures.length === 0) notes.push(`No pictures were found in ${sourceName}.`);
  return { pictures, notes };
}
