import mammoth from "mammoth";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import type { UploadImage } from "./types";

function extFor(mimetype: string): string {
  const subtype = mimetype.split("/")[1] ?? "bin";
  return subtype === "jpeg" ? ".jpg" : `.${subtype}`;
}

/**
 * Converts a .docx buffer to GFM markdown. Embedded images are uploaded as
 * real wiki attachments as mammoth encounters them (via `uploadImage`) and
 * referenced by their attachment URL directly — the same order of
 * operations as a manual import (create the page, upload images, write the
 * body), so no placeholder/substitution pass is needed.
 *
 * Word's highlight-color formatting (commonly used in runbook-style docs to
 * flag "the action to take") has no HTML equivalent, so the style map below
 * degrades any highlighted run to **bold** — the same substitution used
 * when hand-converting these docs.
 */
export async function convertDocx(buffer: Buffer, uploadImage: UploadImage): Promise<string> {
  let counter = 0;
  const result = await mammoth.convertToHtml(
    { buffer },
    {
      styleMap: ["highlight => strong"],
      convertImage: mammoth.images.imgElement(async (image) => {
        counter += 1;
        try {
          const imgBuffer = await image.readAsBuffer();
          const url = await uploadImage({
            filename: `image-${counter}${extFor(image.contentType)}`,
            mimetype: image.contentType,
            buffer: imgBuffer,
          });
          return { src: url };
        } catch {
          // Embedded format we don't accept as an attachment (e.g. legacy
          // WMF/EMF clipart) — drop the image rather than fail the whole
          // import over one figure.
          return { src: "" };
        }
      }),
    },
  );

  const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  turndown.use(gfm);
  return turndown.turndown(result.value).trim();
}
