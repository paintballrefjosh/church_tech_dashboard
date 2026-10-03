/**
 * Tiny MIME sniffer for the file formats we accept as attachments. Covers the
 * "magicful" subset of ATTACHMENT_ALLOWED_CONTENT_TYPES — image/*, video/*,
 * audio/*, application/{pdf,zip}, and docx (a zip container, so it shares
 * zip's signature — see the special case in reconcileMime below). Text
 * formats (plain/markdown/csv/json) have no reliable magic and are
 * validated only by the declared content-type.
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
 *
 * Behaviour:
 *  - declared type is in the magicless set: trust it.
 *  - sniffer detects a type that matches the declared: accept.
 *  - sniffer detects something else: reject (covers `evil.html` claiming PNG).
 *  - sniffer detects nothing and declared isn't magicless: reject (we can't
 *    verify, so we refuse to store).
 */
export function reconcileMime(declared: string, head: Buffer, magicless: ReadonlyArray<string>): string {
  const lower = declared.toLowerCase();
  if (magicless.includes(lower)) return lower;
  const sniffed = sniffMime(head);
  if (!sniffed) {
    throw new Error(`could not verify file type — declared ${declared}, no magic bytes detected`);
  }
  if (sniffed === lower) return sniffed;
  // Accept video/ogg when sniff says audio/ogg, since the container is shared.
  if (sniffed === "audio/ogg" && lower === "video/ogg") return lower;
  // docx is a zip container (PK\x03\x04) with no magic bytes of its own —
  // same accommodation as the audio/video-ogg case above.
  if (
    sniffed === "application/zip" &&
    lower === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return lower;
  }
  throw new Error(`declared content-type ${declared} doesn't match file (detected ${sniffed})`);
}
