/**
 * Reads whatever file an admin gives the importer and returns the pictures in it. What a file is comes from its own first
 * bytes (a zip, an OLE compound file, a picture), never from its name or a type the browser claims; names only choose
 * between files inside an archive. A vendor download is usually a zip holding a Visio stencil in two formats and a
 * PowerPoint copy of the same art: one of them is read (the newest Visio format first) and the others are said to be
 * skipped, so the same pictures do not appear three times.
 */
import { isOle, readOle } from "./ole";
import { isZip, readZip, type ZipEntry } from "./zip";
import { readVisioBinary } from "./visio-binary";
import { readVisioPackage } from "./vsdx";
import { readOfficeMedia, readPowerPointBinary } from "./ppt";
import {
  PICTURE_EXTENSIONS,
  POWERPOINT_EXTENSIONS,
  VISIO_BINARY_EXTENSIONS,
  VISIO_PACKAGE_EXTENSIONS,
  extensionOf,
  sniffPicture,
} from "./sniff";
import { StencilError, type ReadResult, type StencilPicture } from "./types";

export const MAX_FILE_BYTES = 512 * 1024 * 1024;

export interface ReadOptions {
  /** Told what is being read, for a progress line. */
  onProgress?: (text: string) => void;
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
function stem(path: string): string {
  const b = baseName(path);
  const dot = b.lastIndexOf(".");
  return dot > 0 ? b.slice(0, dot) : b;
}

export async function readStencilFile(name: string, bytes: Uint8Array, opts: ReadOptions = {}, depth = 0): Promise<ReadResult> {
  if (bytes.length > MAX_FILE_BYTES) throw new StencilError(`${name} is larger than the ${MAX_FILE_BYTES / 1048576} MiB that can be read.`);
  opts.onProgress?.(`Reading ${name}`);
  let result: ReadResult;
  if (isZip(bytes)) {
    result = await readArchive(name, bytes, opts, depth);
  } else if (isOle(bytes)) {
    const ole = readOle(bytes);
    const has = (s: string) => ole.streams.some((x) => x.name === s);
    if (has("VisioDocument")) result = readVisioBinary(bytes, name);
    else if (has("PowerPoint Document") || has("Pictures")) result = await readPowerPointBinary(bytes, name);
    else throw new StencilError(`${name} is an older Office file this cannot read pictures from (Visio and PowerPoint files can be read).`);
  } else {
    const kind = sniffPicture(bytes);
    if (!kind) throw new StencilError(`${name} is not a kind of file the importer knows. It reads Visio stencils (.vss, .vssx, .vsd, .vsdx), PowerPoint files (.ppt, .pptx), zips of those, and pictures (PNG, JPEG, WebP, GIF, BMP, SVG, EMF).`);
    result = { pictures: [{ id: name, kind, bytes, name: stem(name), description: null, source: name }], notes: [] };
  }
  return depth === 0 ? dedupe(result) : result;
}

async function readArchive(name: string, bytes: Uint8Array, opts: ReadOptions, depth: number): Promise<ReadResult> {
  const entries = readZip(bytes);
  const names = entries.map((e) => e.name);
  if (names.some((n) => n.startsWith("visio/"))) return readVisioPackage(entries, name);
  if (names.some((n) => n.startsWith("ppt/") || n.startsWith("word/") || n.startsWith("xl/"))) return readOfficeMedia(entries, name);
  if (depth >= 2) throw new StencilError(`${name} is a zip inside a zip inside a zip, which is not opened.`);

  // a plain archive: pick the files that hold pictures
  const group = (exts: Set<string>) => entries.filter((e) => exts.has(extensionOf(e.name)) && !baseName(e.name).startsWith("."));
  const visioPackages = group(VISIO_PACKAGE_EXTENSIONS);
  const visioBinaries = group(VISIO_BINARY_EXTENSIONS);
  const powerPoints = group(POWERPOINT_EXTENSIONS);
  const loose = group(PICTURE_EXTENSIONS);
  const archives = group(new Set(["zip"]));
  const notes: string[] = [];
  const pictures: StencilPicture[] = [];

  const readEntries = async (list: ZipEntry[]) => {
    for (const e of list) {
      try {
        const r = await readStencilFile(`${name} > ${baseName(e.name)}`, await e.read(), opts, depth + 1);
        pictures.push(...r.pictures);
        notes.push(...r.notes);
      } catch (err) {
        notes.push(`${baseName(e.name)}: ${(err as Error).message}`);
      }
    }
  };
  const skipped = (list: ZipEntry[], why: string) => {
    if (list.length) notes.push(`Not read, ${why}: ${list.map((e) => baseName(e.name)).join(", ")}.`);
  };

  if (visioPackages.length) {
    await readEntries(visioPackages);
    skipped(visioBinaries, "the same stencil was read from its newer format");
  } else if (visioBinaries.length) {
    await readEntries(visioBinaries);
  }
  if (pictures.length > 0) {
    skipped(powerPoints, "a PowerPoint copy of the same art");
    skipped(loose, "loose pictures beside the stencil");
  } else {
    await readEntries(powerPoints);
    if (pictures.length === 0) await readEntries(loose);
    if (pictures.length === 0) await readEntries(archives);
  }
  if (pictures.length === 0 && notes.length === 0) {
    throw new StencilError(`${name} has no Visio, PowerPoint or picture files in it.`);
  }
  return { pictures, notes };
}

/** FNV-1a over every byte plus the length: enough to tell identical pictures from different ones. */
function fingerprint(b: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) {
    h ^= b[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return `${b.length}:${(h >>> 0).toString(16)}`;
}

/** Drops pictures that are byte for byte the same as an earlier one (a front used by two models), keeping the first's name or the first name found. */
export function dedupe(r: ReadResult): ReadResult {
  const seen = new Map<string, StencilPicture>();
  let dropped = 0;
  const out: StencilPicture[] = [];
  for (const p of r.pictures) {
    const key = fingerprint(p.bytes);
    const first = seen.get(key);
    if (first) {
      dropped++;
      if (!first.name && p.name) {
        first.name = p.name;
        first.description = p.description;
      }
      continue;
    }
    seen.set(key, p);
    out.push(p);
  }
  const notes = dropped > 0 ? [...r.notes, `${dropped} picture${dropped === 1 ? " was" : "s were"} left out because ${dropped === 1 ? "it is" : "they are"} identical to another.`] : r.notes;
  return { pictures: out, notes };
}
