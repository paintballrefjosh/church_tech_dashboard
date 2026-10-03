import type { MediaKind } from "./note-media";

/**
 * One image/video markdown reference parsed out of a note body. `match` is
 * the exact substring (so we can replace it on resize), and `index` is the
 * starting offset in body for ordering.
 */
export interface MediaRef {
  index: number;
  match: string;
  alt: string;
  url: string;
  kind: MediaKind;
  width: number | null;
}

const MEDIA_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;

/**
 * Find every `![alt](url)` token in the body. The URL carries our media
 * metadata as query params: `t=image|video` for kind (default image),
 * `w=<px>` for the user-set width (default null = container width).
 */
function parseMedia(body: string): MediaRef[] {
  const out: MediaRef[] = [];
  for (const m of body.matchAll(MEDIA_RE)) {
    const alt = m[1] ?? "";
    const url = m[2];
    if (!url) continue;
    const qs = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
    const params = new URLSearchParams(qs);
    const t = params.get("t");
    const w = params.get("w");
    out.push({
      index: m.index ?? 0,
      match: m[0],
      alt,
      url,
      kind: t === "video" ? "video" : "image",
      width: w ? Math.max(1, parseInt(w, 10)) : null,
    });
  }
  return out;
}

/**
 * An editor block: a contiguous text run or a single media token. The card
 * renders one editable widget per block in the order returned. Round-tripping
 * (`stringifyBlocks(parseBlocks(b))`) is lossy ONLY in whitespace adjacent
 * to media tokens — see stringifyBlocks for the joining rule.
 */
export type Block =
  | { type: "text"; value: string }
  | { type: "media"; ref: MediaRef };

/**
 * Walk the body, slicing it at every media token. The text between tokens
 * becomes a "text" block; each token itself becomes a "media" block. Empty
 * leading/trailing text blocks are kept so the user always has somewhere to
 * type above/below media when the cursor lands there.
 */
export function parseBlocks(body: string): Block[] {
  const blocks: Block[] = [];
  const media = parseMedia(body);
  let cursor = 0;
  for (const ref of media) {
    blocks.push({ type: "text", value: stripBoundaryNewlines(body.slice(cursor, ref.index)) });
    blocks.push({ type: "media", ref });
    cursor = ref.index + ref.match.length;
  }
  blocks.push({ type: "text", value: stripBoundaryNewlines(body.slice(cursor)) });
  // Always have at least one text block so the card has a place to focus.
  if (blocks.length === 0) blocks.push({ type: "text", value: "" });
  return blocks;
}

/**
 * Reverse of parseBlocks. Text values are written verbatim; media tokens get
 * a blank-line separator from whatever non-empty content precedes them so the
 * markdown stays portable. Empty text blocks (the "anchors" parseBlocks emits
 * around media so the user can land a cursor next to them) contribute
 * nothing, so a leading/trailing empty doesn't produce stray blank lines.
 */
export function stringifyBlocks(blocks: Block[]): string {
  let out = "";
  for (const b of blocks) {
    if (b.type === "text") {
      if (b.value.length === 0) continue;
      if (out.length > 0) out += "\n\n";
      out += b.value;
    } else {
      if (out.length > 0) out += "\n\n";
      out += b.ref.match;
    }
  }
  return out;
}

/**
 * Trim only the structural blank lines that we inject in stringifyBlocks
 * between media and adjacent text. Anything mid-line — and the trailing `\n`
 * a user creates by pressing Enter at the end of the text — must survive.
 */
function stripBoundaryNewlines(s: string): string {
  return s.replace(/^\n{1,2}/, "").replace(/\n{1,2}$/, "");
}

/** Build the markdown snippet inserted into a note after upload. */
export function buildAttachmentMarkdown(opts: {
  noteId: string;
  attachmentId: string;
  filename: string;
  contentType: string;
}): string {
  const kind: MediaKind = opts.contentType.startsWith("video/") ? "video" : "image";
  const alt = opts.filename.replace(/[\[\]()]/g, "");
  const url = `/api/notes/${opts.noteId}/attachments/${opts.attachmentId}?t=${kind}`;
  return `![${alt}](${url})`;
}

/**
 * Replace the matched markdown for `ref` with the same markdown but with the
 * given width. Returns the new body. If no width is given, removes the
 * `w=` param.
 */
export function setMediaWidth(body: string, ref: MediaRef, width: number | null): string {
  const sep = ref.url.includes("?") ? "&" : "?";
  let newUrl = ref.url;
  if (/[?&]w=\d+/.test(ref.url)) {
    newUrl = ref.url.replace(/([?&])w=\d+/, width ? `$1w=${width}` : "$1");
    // Clean up a trailing ? or && from removal.
    newUrl = newUrl.replace(/\?&/, "?").replace(/&$/, "").replace(/\?$/, "");
  } else if (width) {
    newUrl = `${ref.url}${sep}w=${width}`;
  }
  const replacement = `![${ref.alt}](${newUrl})`;
  return body.replace(ref.match, replacement);
}
