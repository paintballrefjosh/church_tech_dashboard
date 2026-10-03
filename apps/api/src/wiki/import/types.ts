export interface ImportImage {
  filename: string;
  mimetype: string;
  buffer: Buffer;
}

/** Uploads one extracted image as a real attachment; resolves to its URL. */
export type UploadImage = (image: ImportImage) => Promise<string>;
