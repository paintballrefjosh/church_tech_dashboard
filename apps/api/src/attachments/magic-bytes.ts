import { findAttachmentType } from "@church/shared";

/**
 * Tiny MIME sniffer for the file formats we accept as attachments (the
 * ATTACHMENT_TYPE_CATALOGUE in @church/shared). Covers image/*, video/*,
 * audio/*, application/{pdf,zip}, and the Office/OpenDocument formats, which
 * are zip containers (docx, xlsx, pptx, odt/ods/odp) or OLE2 compound files
 * (doc, xls, ppt) with no signature of their own: the catalogue's `check` for a
 * type says which container it must be (see reconcileMime). Text formats
 * (plain/markdown/csv/json) have no reliable magic and are validated only by
 * the declared content-type.
 *
 * Returning the detected MIME (not just a boolean) lets the upload path
 * reject mismatches *and* surface a useful error like "you uploaded a PNG
 * but claimed image/jpeg".
 *
 * Why hand-rolled and not the `file-type` npm package: the set of allowed
 * types is small and stable, the project pins dependencies tightly, and
 * `file-type` v19+ is ESM-only which complicates the NestJS CJS build.
 */
function sniffMime(head: Buffer): string | null {
  if (head.length < 4) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
    return "image/png";
  }
  // JPEG: FF D8 FF
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return "image/jpeg";
  }
  // GIF: 47 49 46 38 ("GIF8")
  if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38) {
    return "image/gif";
  }
  // WebP / WAV: RIFF.... <FOURCC>
  if (head.length >= 12 && head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46) {
    const fourcc = head.subarray(8, 12).toString("ascii");
    if (fourcc === "WEBP") return "image/webp";
    if (fourcc === "WAVE") return "audio/wav";
  }
  // PDF: %PDF-
  if (
    head.length >= 5 &&
    head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46 && head[4] === 0x2d
  ) {
    return "application/pdf";
  }
  // ZIP (and ZIP-based formats like docx, jar). PK\x03\x04 (local file header)
  // and PK\x05\x06 (empty archive end-of-central-directory).
  if (head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05) && (head[3] === 0x04 || head[3] === 0x06)) {
    return "application/zip";
  }
  // OLE2 compound file (legacy .doc/.xls/.ppt): D0 CF 11 E0 A1 B1 1A E1
  if (
    head.length >= 8 &&
    head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0 &&
    head[4] === 0xa1 && head[5] === 0xb1 && head[6] === 0x1a && head[7] === 0xe1
  ) {
    return "application/x-ole-storage";
  }
  // MP4 family: 4 bytes size + "ftyp" at offset 4
  if (head.length >= 12 && head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) {
    const brand = head.subarray(8, 12).toString("ascii");
    // QuickTime brand
    if (brand === "qt  ") return "video/quicktime";
    return "video/mp4";
  }
  // WebM / Matroska EBML: 1A 45 DF A3
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    return "video/webm";
  }
  // OGG: "OggS" — used for both audio/ogg and video/ogg. We can't reliably
  // distinguish video-vs-audio from the header alone, so return the audio
  // mime; declared video/ogg uploads will be rejected as a mismatch.
  if (head[0] === 0x4f && head[1] === 0x67 && head[2] === 0x67 && head[3] === 0x53) {
    return "audio/ogg";
  }
  // MP3 with ID3 tag prefix
  if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
    return "audio/mpeg";
  }
  // MP3 raw frame: FF Fx (x indicates layer/protection/bitrate)
  if (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0) {
    return "audio/mpeg";
  }
  return null;
}

/**
 * Validate `declared` against the magic-byte sniff of `head`. Returns the
 * effective content-type to store, or throws an Error describing the mismatch.
 * How strictly a type is checked comes from its catalogue entry (`check`):
 *
 *  - `none`: trust the declared type (plain text formats have no signature).
 *  - `magic`: the sniffed type must be exactly the declared one (this covers
 *    `evil.html` claiming to be a PNG). video/ogg is accepted for an Ogg
 *    container, which sniffs as audio/ogg.
 *  - `zip` / `ole`: the bytes must be a zip / OLE2 container. That cannot tell
 *    a workbook from a document, but it does stop anything else being stored
 *    under an Office type.
 *  - not in the catalogue: refused, we cannot verify it.
 */
export function reconcileMime(declared: string, head: Buffer): string {
  const lower = declared.toLowerCase();
  const info = findAttachmentType(lower);
  if (!info) throw new Error(`content-type ${declared} is not a supported attachment type`);
  if (info.check === "none") return lower;
  const sniffed = sniffMime(head);
  if (!sniffed) {
    throw new Error(`could not verify file type — declared ${declared}, no magic bytes detected`);
  }
  if (info.check === "zip" && sniffed === "application/zip") return lower;
  if (info.check === "ole" && sniffed === "application/x-ole-storage") return lower;
  if (info.check === "magic") {
    if (sniffed === lower) return sniffed;
    // The Ogg container is shared by audio and video.
    if (sniffed === "audio/ogg" && lower === "video/ogg") return lower;
  }
  throw new Error(`declared content-type ${declared} doesn't match file (detected ${sniffed})`);
}
