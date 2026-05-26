import { z } from "zod";

export const WIKI_VISIBILITIES = ["public", "group"] as const;
export type WikiVisibility = (typeof WIKI_VISIBILITIES)[number];

export const wikiPageSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(200),
  body: z.string().max(200_000),
  ownerUserId: z.string().uuid(),
  visibility: z.enum(WIKI_VISIBILITIES),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type WikiPage = z.infer<typeof wikiPageSchema>;

export const wikiAclEntrySchema = z.object({
  groupId: z.string().uuid(),
  canEdit: z.boolean(),
});
export type WikiAclEntry = z.infer<typeof wikiAclEntrySchema>;

export const createWikiPageSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(200_000).default(""),
  visibility: z.enum(WIKI_VISIBILITIES).default("public"),
  acl: z.array(wikiAclEntrySchema).default([]),
});
export type CreateWikiPageInput = z.infer<typeof createWikiPageSchema>;

export const updateWikiPageSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  body: z.string().max(200_000).optional(),
  visibility: z.enum(WIKI_VISIBILITIES).optional(),
  acl: z.array(wikiAclEntrySchema).optional(),
  summary: z.string().max(500).optional(),
});
export type UpdateWikiPageInput = z.infer<typeof updateWikiPageSchema>;

export const wikiPageListQuerySchema = z.object({
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().positive().max(200).default(100),
});
export type WikiPageListQuery = z.infer<typeof wikiPageListQuerySchema>;

export const wikiRevisionSchema = z.object({
  id: z.string().uuid(),
  pageId: z.string().uuid(),
  title: z.string(),
  body: z.string(),
  editorUserId: z.string().uuid().nullable(),
  summary: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type WikiRevision = z.infer<typeof wikiRevisionSchema>;
