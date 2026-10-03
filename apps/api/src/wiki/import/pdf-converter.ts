import pdfParse from "pdf-parse";
import { textToMarkdown } from "./text-converter";

/**
 * PDF import is deliberately best-effort: PDFs carry no reliable document
 * structure to recover (no headings, no lists, no way to tell body text
 * from a caption), so this extracts raw text only — no embedded images, no
 * layout. Same paragraph handling as a .txt import.
 */
export async function convertPdf(buffer: Buffer): Promise<string> {
  const { text } = await pdfParse(buffer);
  return textToMarkdown(text);
}
