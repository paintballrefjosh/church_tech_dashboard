import { z } from "zod";

export const ATTACHMENT_PARENT_TYPES = ["note", "ticket", "ticket_comment", "wiki_page"] as const;
export type AttachmentParentType = (typeof ATTACHMENT_PARENT_TYPES)[number];

/**
 * Content types accepted for upload. Whitelist rather than blacklist so a new
 * dangerous type can't sneak in. Add carefully; SVG and HTML are deliberately
 * excluded (they can execute script via <script>/onclick handlers in viewers
 * that render them inline).
 */
export const ATTACHMENT_ALLOWED_CONTENT_TYPES: ReadonlyArray<string> = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/zip",
  "application/json",
  "application/octet-stream",
];

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MiB

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
