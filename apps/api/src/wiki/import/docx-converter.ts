import mammoth from "mammoth";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import type { UploadImage } from "./types";

function extFor(mimetype: string): string {
  const subtype = mimetype.split("/")[1] ?? "bin";
  return subtype === "jpeg" ? ".jpg" : `.${subtype}`;
}

/** Schemes a link in an imported document may keep. Anything else (javascript:, data:, vbscript:, file: ...) loses its target. */
const SAFE_LINK_SCHEME = /^(https?|mailto|tel):/i;

/**
 * Word hyperlinks carry whatever target the author (or an attacker) put in the file. The wiki's viewer already refuses
 * unsafe schemes, but the page body is also read by the editor, search, exports and API/MCP clients, so an unsafe link
 * is not stored at all: the text stays, the target goes. Mammoth writes every attribute double-quoted and escaped, so
 * matching `<a href="...">` is reliable.
 */
export function dropUnsafeLinks(html: string): string {
  return html.replace(/<a href="([^"]*)"/g, (whole, href: string) => {
    // Browsers ignore whitespace and control characters inside a scheme ("java\tscript:"), so judge without them.
    const target = href.replace(/[\u0000-\u0020]/g, "");
    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(target);
    return !hasScheme || SAFE_LINK_SCHEME.test(target) ? whole : "<a";
  });
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
  // Text that merely LOOKS like markup in the document ("<b>", "<img onerror=...>") must stay text in the page.
  const escapeMarkdown = turndown.escape.bind(turndown);
  turndown.escape = (text: string) => escapeMarkdown(text).replace(/</g, "\\<");
  return turndown.turndown(dropUnsafeLinks(result.value)).trim();
}
