const LEADING_MARKDOWN = /^([#>*+-]|\d+[.)])/;

function escapeLeadingMarkdown(line: string): string {
  return LEADING_MARKDOWN.test(line) ? `\\${line}` : line;
}

/**
 * Converts loose plain text (a .txt file, or text extracted from a PDF) into
 * safe markdown: blank-line-separated chunks become paragraphs, single line
 * breaks within a chunk fold to a space (matching how CommonMark treats a
 * single newline in real markdown source), and any line that opens with a
 * markdown-significant character is escaped so plain text can't accidentally
 * produce a heading/list/quote it never intended.
 */
export function textToMarkdown(text: string): string {
  const paragraphs = text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) =>
      chunk
        .split("\n")
        .map((line) => escapeLeadingMarkdown(line.trim()))
        .filter(Boolean)
        .join(" "),
    );
  return paragraphs.join("\n\n");
}
