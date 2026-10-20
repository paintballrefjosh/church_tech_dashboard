/**
 * The pixel size of a PNG, JPEG or WebP read from its own bytes (the browser draws the picture, the layout needs its
 * proportions up front). Returns null for anything else or a file too short or odd to read; never throws.
 */
export function imageSize(buf: Buffer): { width: number; height: number; type: "image/png" | "image/jpeg" | "image/webp" } | null {
  try {
    return png(buf) ?? jpeg(buf) ?? webp(buf);
  } catch {
    return null;
  }
}

function ok(width: number, height: number, type: "image/png" | "image/jpeg" | "image/webp") {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= 30000 && height <= 30000
    ? { width, height, type }
    : null;
}

function png(b: Buffer) {
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47 || b.toString("ascii", 12, 16) !== "IHDR") return null;
  return ok(b.readUInt32BE(16), b.readUInt32BE(20), "image/png");
}

function jpeg(b: Buffer) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    // Markers with no length: restart markers, SOI, EOI, TEM.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    const len = b.readUInt16BE(i + 2);
    // Start of frame (baseline, progressive, ...), except DHT (c4), JPG (c8) and DAC (cc).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return ok(b.readUInt16BE(i + 7), b.readUInt16BE(i + 5), "image/jpeg");
    }
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

function webp(b: Buffer) {
  if (b.length < 30 || b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WEBP") return null;
  const kind = b.toString("ascii", 12, 16);
  if (kind === "VP8 ") {
    // Lossy: a 3 byte frame tag, the 9d 01 2a start code, then 14 bit width and height.
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return ok(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff, "image/webp");
  }
  if (kind === "VP8L") {
    if (b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    return ok((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1, "image/webp");
  }
  if (kind === "VP8X") {
    return ok(1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)), "image/webp");
  }
  return null;
}
