import { z } from "zod";

export const NOTE_COLORS = [
  "default",
  "amber",
  "rose",
  "emerald",
  "sky",
  "violet",
  "slate",
] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];

export const noteSchema = z.object({
  id: z.string().uuid(),
  ownerUserId: z.string().uuid(),
  title: z.string().max(200),
  body: z.string().max(20_000),
  color: z.enum(NOTE_COLORS),
  pinned: z.boolean(),
  archived: z.boolean(),
  gridX: z.number().int().nullable(),
  gridY: z.number().int().nullable(),
  gridW: z.number().int().nullable(),
  gridH: z.number().int().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Note = z.infer<typeof noteSchema>;

export const createNoteSchema = z.object({
  title: z.string().max(200).default(""),
  body: z.string().max(20_000).default(""),
  color: z.enum(NOTE_COLORS).default("default"),
  pinned: z.boolean().default(false),
});
export type CreateNoteInput = z.infer<typeof createNoteSchema>;

export const updateNoteSchema = z.object({
  title: z.string().max(200).optional(),
  body: z.string().max(20_000).optional(),
  color: z.enum(NOTE_COLORS).optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  gridX: z.number().int().min(0).max(11).nullable().optional(),
  gridY: z.number().int().min(0).max(1000).nullable().optional(),
  gridW: z.number().int().min(1).max(12).nullable().optional(),
  gridH: z.number().int().min(1).max(40).nullable().optional(),
});
export type UpdateNoteInput = z.infer<typeof updateNoteSchema>;

export const noteListQuerySchema = z.object({
  archived: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .transform((v) => (typeof v === "boolean" ? v : v === "true"))
    .optional(),
  q: z.string().max(200).optional(),
  tagId: z.string().uuid().optional(),
});
export type NoteListQuery = z.infer<typeof noteListQuerySchema>;
