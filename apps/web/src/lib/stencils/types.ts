export type PictureKind = "emf" | "wmf" | "png" | "jpeg" | "gif" | "bmp" | "webp" | "svg" | "dib" | "tiff" | "pict";

/** A picture found inside a file the admin gave us: a stencil master, a slide's picture, or the file itself. */
export interface StencilPicture {
  /** Unique within one import. */
  id: string;
  kind: PictureKind;
  bytes: Uint8Array;
  /** What the source calls it (a Visio master's name or product id), or null when it has no name. */
  name: string | null;
  /** A longer description (a Visio master's prompt text), or null. */
  description: string | null;
  /** Where it came from, in words: the file and the part of it. */
  source: string;
}

/** What went wrong or was left out while reading, in words an admin can act on. */
export interface ReadResult {
  pictures: StencilPicture[];
  notes: string[];
}

export class StencilError extends Error {}
