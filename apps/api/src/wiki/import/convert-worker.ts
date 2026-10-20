/**
 * The child process that actually reads an uploaded .docx or .pdf (see convert-sandbox.ts for why it is a
 * separate process). It holds no database connection, no settings and no secrets: it gets the file's bytes,
 * hands every embedded image back to the API to be stored (the API owns the permissions and the object
 * store), and answers with the markdown.
 *
 * Messages use Node's "advanced" serialization so bytes travel as bytes.
 *   API -> worker: { type: "convert", kind, data } and { type: "image-url", id, url | null }
 *   worker -> API: { type: "image", id, filename, mimetype, data }, then { type: "done", markdown } or { type: "error", message }
 */
import { convertDocx } from "./docx-converter";
import { convertPdf } from "./pdf-converter";
import type { UploadImage } from "./types";

type FromApi =
  | { type: "convert"; kind: "docx" | "pdf"; data: Uint8Array }
  | { type: "image-url"; id: number; url: string | null };

const waiting = new Map<number, (url: string | null) => void>();
let nextImageId = 0;

function send(message: unknown, then?: () => void): void {
  if (!process.send) process.exit(2);
  process.send(message as never, undefined, undefined, () => then?.());
}

const uploadImage: UploadImage = (image) =>
  new Promise<string>((resolve, reject) => {
    const id = ++nextImageId;
    waiting.set(id, (url) => (url === null ? reject(new Error("image not stored")) : resolve(url)));
    send({ type: "image", id, filename: image.filename, mimetype: image.mimetype, data: image.buffer });
  });

process.on("message", (raw: FromApi) => {
  if (raw.type === "image-url") {
    waiting.get(raw.id)?.(raw.url);
    waiting.delete(raw.id);
    return;
  }
  const data = Buffer.from(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength);
  const work = raw.kind === "docx" ? convertDocx(data, uploadImage) : convertPdf(data);
  work.then(
    (markdown) => send({ type: "done", markdown }, () => process.exit(0)),
    (err: unknown) => send({ type: "error", message: err instanceof Error ? err.message : "unknown error" }, () => process.exit(0)),
  );
});
