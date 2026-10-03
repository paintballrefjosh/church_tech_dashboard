import { z } from "zod";

/**
 * Tag colour palette. Names map to Tailwind classes in the UI; keep this list
 * small so the tag picker doesn't become its own design problem.
 */
export const TAG_COLORS = [
  "slate",
  "rose",
  "amber",
  "emerald",
  "sky",
  "violet",
  "fuchsia",
] as const;
export type TagColor = (typeof TAG_COLORS)[number];

/** Resource types we currently allow tags on. */
export const TAGGABLE_RESOURCE_TYPES = ["ticket", "note", "wiki_page"] as const;
export type TaggableResourceType = (typeof TAGGABLE_RESOURCE_TYPES)[number];

export const tagSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(64),
  color: z.enum(TAG_COLORS),
  createdAt: z.string().datetime(),
});
export type Tag = z.infer<typeof tagSchema>;

export const createTagSchema = z.object({
  name: z.string().trim().min(1).max(64),
  color: z.enum(TAG_COLORS).default("slate"),
});
export type CreateTagInput = z.infer<typeof createTagSchema>;

export const updateTagSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  color: z.enum(TAG_COLORS).optional(),
});
export type UpdateTagInput = z.infer<typeof updateTagSchema>;

/**
 * Setting tags on a resource — full replace semantics. The client sends the
 * intended end-state; the API replaces existing assignments wholesale.
 */
export const setResourceTagsSchema = z.object({
  tagIds: z.array(z.string().uuid()).max(20),
});
export type SetResourceTagsInput = z.infer<typeof setResourceTagsSchema>;
