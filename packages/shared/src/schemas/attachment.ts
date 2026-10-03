import { z } from "zod";

export const ATTACHMENT_PARENT_TYPES = ["note", "ticket", "ticket_comment", "wiki_page"] as const;
export type AttachmentParentType = (typeof ATTACHMENT_PARENT_TYPES)[number];

/**
 * Content types accepted for upload. Whitelist rather than blacklist so a new
 * dangerous type can't sneak in. Add carefully; SVG and HTML are deliberately
 * excluded (they can execute script via <script>/onclick handlers in viewers
 * that render them inline). application/octet-stream is also excluded — it's
 * the universal fallback any client can claim, and would defeat magic-byte
 * validation by giving the API no declared type to compare against.
 */
export const ATTACHMENT_ALLOWED_CONTENT_TYPES: ReadonlyArray<string> = [
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

/**
 * Subset of allowed types that have no reliable magic-byte signature. The
 * attachments service trusts the declared content-type for these and skips
 * magic-byte verification; for everything else, the leading bytes must
 * match the declared type or the upload is rejected.
 */
export const ATTACHMENT_MAGICLESS_TYPES: ReadonlyArray<string> = [
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
];

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
