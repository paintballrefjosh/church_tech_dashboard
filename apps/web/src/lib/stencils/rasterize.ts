/**
 * Turns a picture found in a file into the PNG, JPEG or WebP the switch models store (the server only takes those, and
 * checks them against their own bytes). Vector art (EMF, SVG) is drawn on a canvas and its empty margin cut off, so the
 * port boxes drawn later sit on the switch and not on the page around it. A ready raster picture that is already
 * small enough is kept exactly as it was. Browser only.
 */
import { drawEmf, readEmfHeader } from "./emf";
import { StencilError, type StencilPicture } from "./types";

/** What the API accepts for a picture (see MAX_SWITCH_IMAGE_BYTES in apps/api/src/switch-models): 8 MiB; stay under it. */
export const MAX_UPLOAD_BYTES = 7.5 * 1024 * 1024;
const MAX_CANVAS_EDGE = 6000;

export interface RenderedPicture {
  blob: Blob;
  width: number;
  height: number;
  /** True when the bytes are the file's own, not a re-drawing. */
  original: boolean;
}

function canvasOf(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function toBlob(c: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new StencilError("The browser could not make a picture from this."))), "image/png"));
}

/** A bitmap with no file header (a DIB, as PowerPoint stores one) gets the 14-byte BMP header in front of it. */
function dibToBmp(dib: Uint8Array): Uint8Array {
  const dv = new DataView(dib.buffer, dib.byteOffset, dib.byteLength);
  const headerSize = dv.getUint32(0, true);
  const bpp = dv.getUint16(14, true);
  const colours = dv.getUint32(32, true) || (bpp <= 8 ? 1 << bpp : 0);
  const compression = dv.getUint32(16, true);
  const masks = compression === 3 && headerSize === 40 ? 12 : 0;
  const bits = 14 + headerSize + masks + colours * 4;
  const out = new Uint8Array(14 + dib.length);
  out[0] = 0x42;
  out[1] = 0x4d;
  new DataView(out.buffer).setUint32(2, out.length, true);
  new DataView(out.buffer).setUint32(10, bits, true);
  out.set(dib, 14);
  return out;
}

const MIME: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml" };

/** Cuts away the transparent margin (alpha under 8) and returns the cropped canvas, or the same one if there is none. */
function trim(c: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return c;
  const { width, height } = c;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3]! >= 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return c; // nothing drawn at all
  if (minX === 0 && minY === 0 && maxX === width - 1 && maxY === height - 1) return c;
  const out = canvasOf(maxX - minX + 1, maxY - minY + 1);
  out.getContext("2d")!.drawImage(c, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

async function loadSvg(bytes: Uint8Array, maxWidth: number): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: MIME.svg }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    // an SVG with no size of its own reports 0 or a default: give it a sensible one
    const nw = img.naturalWidth || 1000;
    const nh = img.naturalHeight || 1000;
    const w = Math.min(maxWidth, Math.max(nw, 800));
    const h = Math.max(1, Math.round((nh * w) / nw));
    const c = canvasOf(w, h);
    c.getContext("2d")!.drawImage(img, 0, 0, w, h);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function drawRaster(p: StencilPicture): Promise<{ canvas: HTMLCanvasElement; opaque: boolean }> {
  const bytes = p.kind === "dib" ? dibToBmp(p.bytes) : p.bytes;
  const type = p.kind === "dib" ? MIME.bmp! : MIME[p.kind];
  if (!type) throw new StencilError(`${p.kind.toUpperCase()} pictures cannot be drawn by this browser.`);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type }));
  } catch {
    throw new StencilError("This picture could not be decoded.");
  }
  if (bitmap.width > MAX_CANVAS_EDGE * 2 || bitmap.height > MAX_CANVAS_EDGE * 2) throw new StencilError("This picture is too large (over 12000 pixels on a side).");
  const c = canvasOf(bitmap.width, bitmap.height);
  c.getContext("2d")!.drawImage(bitmap, 0, 0);
  bitmap.close();
  return { canvas: c, opaque: p.kind === "jpeg" || p.kind === "bmp" || p.kind === "dib" };
}

/**
 * The picture as something the server will store. `maxWidth` is how wide to draw vector art (about twice its own size for
 * a crisp port editor); large raster pictures are scaled to fit it too.
 */
export async function renderPicture(p: StencilPicture, maxWidth = 3200): Promise<RenderedPicture> {
  if (p.kind === "wmf" || p.kind === "pict" || p.kind === "tiff") {
    throw new StencilError(`${p.kind.toUpperCase()} pictures cannot be drawn yet. If the file also holds the same art as an EMF or Visio stencil, use that.`);
  }
  let canvas: HTMLCanvasElement;
  let opaque = false;
  let originalUsable = false;

  if (p.kind === "emf") {
    const h = readEmfHeader(p.bytes);
    if (!h) throw new StencilError("This is not a readable EMF picture.");
    // twice its own size reads well in the editor; never past the cap or the canvas limit
    let scale = Math.min(maxWidth, Math.max(h.width * 2, 800)) / h.width;
    scale = Math.min(scale, MAX_CANVAS_EDGE / h.width, MAX_CANVAS_EDGE / h.height);
    canvas = canvasOf(Math.max(1, Math.ceil(h.width * scale)), Math.max(1, Math.ceil(h.height * scale)));
    drawEmf(p.bytes, canvas.getContext("2d")!, { scale });
  } else if (p.kind === "svg") {
    canvas = await loadSvg(p.bytes, maxWidth);
  } else {
    const r = await drawRaster(p);
    canvas = r.canvas;
    opaque = r.opaque;
    originalUsable = (p.kind === "png" || p.kind === "jpeg" || p.kind === "webp") && p.bytes.length <= MAX_UPLOAD_BYTES && canvas.width <= maxWidth;
  }

  if (!opaque) {
    const trimmed = trim(canvas);
    if (trimmed !== canvas) originalUsable = false;
    canvas = trimmed;
  }
  if (originalUsable) {
    return { blob: new Blob([p.bytes as BlobPart], { type: MIME[p.kind] }), width: canvas.width, height: canvas.height, original: true };
  }
  // a raster picture wider than asked for is scaled down
  if (canvas.width > maxWidth) {
    const k = maxWidth / canvas.width;
    const small = canvasOf(maxWidth, Math.max(1, Math.round(canvas.height * k)));
    small.getContext("2d")!.drawImage(canvas, 0, 0, small.width, small.height);
    canvas = small;
  }
  // a PNG over the upload limit is drawn smaller until it fits
  let blob = await toBlob(canvas);
  for (let i = 0; i < 4 && blob.size > MAX_UPLOAD_BYTES; i++) {
    const small = canvasOf(Math.max(1, Math.round(canvas.width * 0.75)), Math.max(1, Math.round(canvas.height * 0.75)));
    small.getContext("2d")!.drawImage(canvas, 0, 0, small.width, small.height);
    canvas = small;
    blob = await toBlob(canvas);
  }
  if (blob.size > MAX_UPLOAD_BYTES) throw new StencilError("This picture is too large to store even when scaled down.");
  return { blob, width: canvas.width, height: canvas.height, original: false };
}
