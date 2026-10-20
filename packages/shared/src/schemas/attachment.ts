import { z } from "zod";

export const ATTACHMENT_PARENT_TYPES = ["note", "ticket", "ticket_comment", "wiki_page", "switch_model"] as const;
export type AttachmentParentType = (typeof ATTACHMENT_PARENT_TYPES)[number];

/**
 * How the API checks that an uploaded file really is what it claims to be.
 *  - `magic`: the leading bytes must sniff as exactly the declared type.
 *  - `zip`:   an Office/OpenDocument file; a zip container, so the bytes must sniff as a zip.
 *  - `ole`:   a legacy Office file (doc/xls/ppt); an OLE2 compound file.
 *  - `none`:  plain text formats with no signature; the declared type is trusted.
 */
export type AttachmentCheck = "magic" | "zip" | "ole" | "none";

export interface AttachmentTypeInfo {
  mime: string;
  label: string;
  /** Shown to admins, e.g. ".xlsx". */
  ext: string;
  group: "Images" | "Video" | "Audio" | "Documents" | "Text" | "Archives";
  check: AttachmentCheck;
}

/**
 * Every content type an admin may allow for upload. A whitelist, deliberately closed: the list
 * an admin edits (setting `attachments.allowed_types`) can only contain entries from here, so a
 * dangerous type can never be switched on. SVG and HTML are excluded (they run script in viewers
 * that render them inline). application/octet-stream is excluded too: it is the universal
 * fallback any client can claim, and it would defeat the byte check by giving the API no
 * declared type to compare against. Add to this list carefully, with a `check` that can verify it.
 */
export const ATTACHMENT_TYPE_CATALOGUE: ReadonlyArray<AttachmentTypeInfo> = [
  { mime: "image/png", label: "PNG image", ext: ".png", group: "Images", check: "magic" },
  { mime: "image/jpeg", label: "JPEG image", ext: ".jpg", group: "Images", check: "magic" },
  { mime: "image/gif", label: "GIF image", ext: ".gif", group: "Images", check: "magic" },
  { mime: "image/webp", label: "WebP image", ext: ".webp", group: "Images", check: "magic" },
  { mime: "video/mp4", label: "MP4 video", ext: ".mp4", group: "Video", check: "magic" },
  { mime: "video/webm", label: "WebM video", ext: ".webm", group: "Video", check: "magic" },
  { mime: "video/ogg", label: "Ogg video", ext: ".ogv", group: "Video", check: "magic" },
  { mime: "video/quicktime", label: "QuickTime video", ext: ".mov", group: "Video", check: "magic" },
  { mime: "audio/mpeg", label: "MP3 audio", ext: ".mp3", group: "Audio", check: "magic" },
  { mime: "audio/ogg", label: "Ogg audio", ext: ".ogg", group: "Audio", check: "magic" },
  { mime: "audio/wav", label: "WAV audio", ext: ".wav", group: "Audio", check: "magic" },
  { mime: "application/pdf", label: "PDF", ext: ".pdf", group: "Documents", check: "magic" },
  {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    label: "Word document",
    ext: ".docx",
    group: "Documents",
    check: "zip",
  },
  {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    label: "Excel workbook",
    ext: ".xlsx",
    group: "Documents",
    check: "zip",
  },
  {
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    label: "PowerPoint presentation",
    ext: ".pptx",
    group: "Documents",
    check: "zip",
  },
  { mime: "application/vnd.oasis.opendocument.text", label: "OpenDocument text", ext: ".odt", group: "Documents", check: "zip" },
  {
    mime: "application/vnd.oasis.opendocument.spreadsheet",
    label: "OpenDocument spreadsheet",
    ext: ".ods",
    group: "Documents",
    check: "zip",
  },
  {
    mime: "application/vnd.oasis.opendocument.presentation",
    label: "OpenDocument presentation",
    ext: ".odp",
    group: "Documents",
    check: "zip",
  },
  { mime: "application/msword", label: "Word document (old format)", ext: ".doc", group: "Documents", check: "ole" },
  { mime: "application/vnd.ms-excel", label: "Excel workbook (old format)", ext: ".xls", group: "Documents", check: "ole" },
  {
    mime: "application/vnd.ms-powerpoint",
    label: "PowerPoint presentation (old format)",
    ext: ".ppt",
    group: "Documents",
    check: "ole",
  },
  { mime: "text/plain", label: "Plain text", ext: ".txt", group: "Text", check: "none" },
  { mime: "text/markdown", label: "Markdown", ext: ".md", group: "Text", check: "none" },
  { mime: "text/csv", label: "CSV", ext: ".csv", group: "Text", check: "none" },
  { mime: "application/json", label: "JSON", ext: ".json", group: "Text", check: "none" },
  { mime: "application/zip", label: "Zip archive", ext: ".zip", group: "Archives", check: "magic" },
];

/** Allowed until an admin changes it: what the app accepted before the list became a setting. */
export const DEFAULT_ATTACHMENT_TYPES: ReadonlyArray<string> = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/quicktime",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/zip",
  "application/json",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

export const ATTACHMENT_TYPES_SETTING = "attachments.allowed_types";
export const ATTACHMENT_CUSTOM_EXTENSIONS_SETTING = "attachments.custom_extensions";

/**
 * Custom file extensions: types the catalogue does not know, added by an admin (setting
 * `attachments.custom_extensions`, bare lowercase extensions such as "dwg"). They cannot be
 * verified against the file's bytes, so the rules are stricter than for catalogue types:
 *  - matched by the file name's extension only, never by what the browser claims;
 *  - always stored and served as application/octet-stream, which downloads as a file
 *    (only image/* is ever shown inline) and is never sniffed (nosniff);
 *  - extensions that run in a browser or on a person's computer when opened are refused outright
 *    (BLOCKED_ATTACHMENT_EXTENSIONS), as are extensions the checklist already covers, so
 *    unticking a type there cannot be undone by adding its extension here.
 */
export const CUSTOM_ATTACHMENT_CONTENT_TYPE = "application/octet-stream";
export const MAX_CUSTOM_ATTACHMENT_EXTENSIONS = 50;

export const BLOCKED_ATTACHMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  // run script in a browser
  "html", "htm", "xhtml", "xht", "shtml", "svg", "svgz", "xml", "xsl", "xslt", "js", "mjs", "cjs", "css", "swf", "hta",
  // run on a person's computer when opened
  "exe", "msi", "msp", "bat", "cmd", "com", "scr", "pif", "ps1", "psm1", "vbs", "vbe", "wsf", "wsh", "jar", "dll",
  "lnk", "reg", "inf", "cpl", "sh", "app", "dmg", "pkg", "apk", "deb", "rpm",
  // run on a server that happened to serve them
  "php", "phtml", "asp", "aspx", "jsp", "cgi",
]);

/** Extensions the checklist already covers (the catalogue's, plus the common alias .jpeg). */
function catalogueExtensions(): Set<string> {
  const out = new Set(ATTACHMENT_TYPE_CATALOGUE.map((t) => t.ext.replace(/^\./, "")));
  out.add("jpeg");
  return out;
}

export type CustomExtensionResult = { ok: true; ext: string } | { ok: false; error: string };

/** Clean up what an admin typed (".DWG", "*.dwg", " dwg ") into a bare lowercase extension, or say why not. */
export function normaliseCustomExtension(input: string): CustomExtensionResult {
  const ext = input.trim().toLowerCase().replace(/^\*?\.+/, "");
  if (!/^[a-z0-9]{1,8}$/.test(ext)) {
    return { ok: false, error: `"${input.trim()}" is not a file extension: use 1 to 8 letters or digits, for example dwg.` };
  }
  if (BLOCKED_ATTACHMENT_EXTENSIONS.has(ext)) {
    return { ok: false, error: `.${ext} files can run code when opened, so they cannot be allowed.` };
  }
  if (catalogueExtensions().has(ext)) {
    return { ok: false, error: `.${ext} is already covered by the checklist above; tick it there.` };
  }
  return { ok: true, ext };
}

/** The effective custom extensions from a stored setting value: valid, unique, capped; anything else is dropped. */
export function resolveCustomAttachmentExtensions(stored: unknown): string[] {
  if (!Array.isArray(stored)) return [];
  const out: string[] = [];
  for (const v of stored) {
    if (typeof v !== "string") continue;
    const r = normaliseCustomExtension(v);
    if (r.ok && !out.includes(r.ext)) out.push(r.ext);
    if (out.length >= MAX_CUSTOM_ATTACHMENT_EXTENSIONS) break;
  }
  return out;
}

/** Catalogue entry for a content type, or undefined when it is not one an admin can allow. */
export function findAttachmentType(mime: string): AttachmentTypeInfo | undefined {
  const lower = mime.toLowerCase();
  return ATTACHMENT_TYPE_CATALOGUE.find((t) => t.mime === lower);
}

/**
 * The effective allowed list from a stored setting value: catalogue entries only, so a bad
 * or hand-edited value can never allow a type outside the catalogue. Anything that is not a
 * list falls back to the defaults; an empty list is honoured (uploads off).
 */
export function resolveAllowedAttachmentTypes(stored: unknown): string[] {
  if (!Array.isArray(stored)) return [...DEFAULT_ATTACHMENT_TYPES];
  return ATTACHMENT_TYPE_CATALOGUE.map((t) => t.mime).filter((m) => stored.includes(m));
}

/** Subset of the catalogue that has no reliable signature (see `AttachmentCheck`). */
export const ATTACHMENT_MAGICLESS_TYPES: ReadonlyArray<string> = ATTACHMENT_TYPE_CATALOGUE.filter(
  (t) => t.check === "none",
).map((t) => t.mime);

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MiB

/**
 * Cap for the *source* file handed to the wiki importer (docx/txt/pdf) —
 * separate from MAX_ATTACHMENT_BYTES because a Word doc with several
 * embedded photos is comfortably bigger than a single attachment, while
 * each image it contains still goes through the normal per-attachment
 * upload path (and cap) as it's extracted.
 */
export const MAX_IMPORT_SOURCE_BYTES = 20 * 1024 * 1024; // 20 MiB

export const attachmentSchema = z.object({
  id: z.string().uuid(),
  parentType: z.enum(ATTACHMENT_PARENT_TYPES),
  parentId: z.string().uuid(),
  uploaderUserId: z.string().uuid().nullable(),
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1).max(127),
  sizeBytes: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
});
export type Attachment = z.infer<typeof attachmentSchema>;
