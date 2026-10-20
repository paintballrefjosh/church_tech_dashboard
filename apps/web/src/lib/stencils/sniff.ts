import { readEmfHeader } from "./emf";
import type { PictureKind } from "./types";

/** What a picture is, from its own first bytes (never from a file name or a type a browser claims). */
export function sniffPicture(b: Uint8Array): PictureKind | null {
  if (b.length < 8) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp";
  if (b[0] === 0x42 && b[1] === 0x4d && b.length > 26) return "bmp";
  if (readEmfHeader(b)) return "emf";
  // WMF: an Aldus placeable header, or a plain metafile header (type 1 or 2, header size 9 words)
  if (b[0] === 0xd7 && b[1] === 0xcd && b[2] === 0xc6 && b[3] === 0x9a) return "wmf";
  if ((b[0] === 1 || b[0] === 2) && b[1] === 0 && b[2] === 9 && b[3] === 0) return "wmf";
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a)) return "tiff";
  // SVG is text: look for an <svg element near the start (after an XML declaration, comments, a BOM)
  const head = new TextDecoder("utf-8").decode(b.subarray(0, Math.min(b.length, 2048)));
  if (/^﻿?\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(head)) return "svg";
  return null;
}

/** Extensions of files that can hold pictures, by what to do with them. */
export const PICTURE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "emf", "wmf", "tif", "tiff"]);
export const VISIO_PACKAGE_EXTENSIONS = new Set(["vsdx", "vssx", "vsdm", "vssm"]);
export const VISIO_BINARY_EXTENSIONS = new Set(["vsd", "vss"]);
export const POWERPOINT_EXTENSIONS = new Set(["ppt", "pptx"]);

export function extensionOf(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot < 0 ? "" : base.slice(dot + 1).toLowerCase();
}
