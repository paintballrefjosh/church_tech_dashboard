import { z } from "zod";

export const WIKI_VISIBILITIES = ["public", "group"] as const;
export type WikiVisibility = (typeof WIKI_VISIBILITIES)[number];

export const wikiPageSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(200),
  body: z.string().max(200_000),
  ownerUserId: z.string().uuid(),
  visibility: z.enum(WIKI_VISIBILITIES),
  parentId: z.string().uuid().nullable(),
  parentFolderId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type WikiPage = z.infer<typeof wikiPageSchema>;

/**
 * Folders are pure organizational containers — no body, no ACL of their own.
 * A page's own visibility/ACL governs its access regardless of which folder
 * it sits in.
 */
export const wikiFolderSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(200),
  parentFolderId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type WikiFolder = z.infer<typeof wikiFolderSchema>;

export const createWikiFolderSchema = z.object({
  name: z.string().min(1).max(200),
  parentFolderId: z.string().uuid().nullable().optional(),
});
export type CreateWikiFolderInput = z.infer<typeof createWikiFolderSchema>;

export const updateWikiFolderSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  parentFolderId: z.string().uuid().nullable().optional(),
});
export type UpdateWikiFolderInput = z.infer<typeof updateWikiFolderSchema>;

/**
 * A single flat list backing the merged wiki tree (folders + pages). Each
 * row names at most one of {parentId, parentFolderId}; null/null = root.
 * Shared by GET /wiki/tree — kept as its own schema so web/api agree on shape.
 */
export const wikiTreeNodeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("folder"),
    id: z.string().uuid(),
    name: z.string(),
    parentFolderId: z.string().uuid().nullable(),
  }),
  z.object({
    kind: z.literal("page"),
    id: z.string().uuid(),
    title: z.string(),
    parentId: z.string().uuid().nullable(),
    parentFolderId: z.string().uuid().nullable(),
  }),
]);
export type WikiTreeNode = z.infer<typeof wikiTreeNodeSchema>;

export const wikiAclEntrySchema = z.object({
  groupId: z.string().uuid(),
  canEdit: z.boolean(),
});
export type WikiAclEntry = z.infer<typeof wikiAclEntrySchema>;

export const createWikiPageSchema = z
  .object({
    title: z.string().min(1).max(200),
    body: z.string().max(200_000).default(""),
    visibility: z.enum(WIKI_VISIBILITIES).default("public"),
    acl: z.array(wikiAclEntrySchema).default([]),
    parentId: z.string().uuid().nullable().optional(),
    parentFolderId: z.string().uuid().nullable().optional(),
  })
  .refine((v) => !(v.parentId && v.parentFolderId), {
    message: "A page can't have both a parent page and a parent folder",
    path: ["parentFolderId"],
  });
export type CreateWikiPageInput = z.infer<typeof createWikiPageSchema>;

export const updateWikiPageSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    body: z.string().max(200_000).optional(),
    visibility: z.enum(WIKI_VISIBILITIES).optional(),
    acl: z.array(wikiAclEntrySchema).optional(),
    summary: z.string().max(500).optional(),
    parentId: z.string().uuid().nullable().optional(),
    parentFolderId: z.string().uuid().nullable().optional(),
  })
  .refine((v) => !(v.parentId && v.parentFolderId), {
    message: "A page can't have both a parent page and a parent folder",
    path: ["parentFolderId"],
  });
export type UpdateWikiPageInput = z.infer<typeof updateWikiPageSchema>;

/**
 * Metadata for POST /wiki/import, carried as query params rather than
 * multipart fields — @fastify/multipart only reliably populates a file
 * part's sibling `.fields` when they precede the file in the stream, so
 * query params sidestep that ordering footgun entirely. The file itself is
 * the multipart body.
 */
export const importWikiQuerySchema = z.object({
  title: z.string().min(1).max(200).optional(),
  visibility: z.enum(WIKI_VISIBILITIES).optional(),
  parentId: z.string().uuid().optional(),
  parentFolderId: z.string().uuid().optional(),
  // JSON-encoded WikiAclEntry[] — query params are strings only, so a
  // structured value has to ride as a serialized string rather than a
  // native array like createWikiPageSchema's `acl` field.
  acl: z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (!raw) return undefined;
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "acl must be valid JSON" });
        return z.NEVER;
      }
      const result = z.array(wikiAclEntrySchema).safeParse(value);
      if (!result.success) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "acl must be an array of {groupId, canEdit}" });
        return z.NEVER;
      }
      return result.data;
    }),
});
export type ImportWikiQuery = z.infer<typeof importWikiQuerySchema>;

export const wikiPageListQuerySchema = z.object({
  q: z.string().max(200).optional(),
  tagId: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(200).default(100),
});
export type WikiPageListQuery = z.infer<typeof wikiPageListQuerySchema>;

export const wikiRevisionSchema = z.object({
  id: z.string().uuid(),
  pageId: z.string().uuid(),
  title: z.string(),
  body: z.string(),
  editorUserId: z.string().uuid().nullable(),
  // Denormalized from a join at read time (not stored) — null when the
  // editor account no longer exists (editorUserId itself already went null
  // via the FK's ON DELETE SET NULL in that case).
  editorName: z.string().nullable(),
  editorEmail: z.string().nullable(),
  summary: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type WikiRevision = z.infer<typeof wikiRevisionSchema>;
