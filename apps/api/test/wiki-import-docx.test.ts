import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { convertDocx, dropUnsafeLinks } from "../src/wiki/import/docx-converter";

describe("dropUnsafeLinks", () => {
  it("keeps web, mail, phone, relative and anchor links", () => {
    for (const href of ["https://example.com/a?b=1&amp;c=2", "http://x.test", "mailto:a@b.c", "tel:+441234", "/wiki/abc", "#top", "page.html"]) {
      const html = `<a href="${href}">t</a>`;
      expect(dropUnsafeLinks(html)).toBe(html);
    }
  });

  it("removes the target of every other scheme, however it is spelled", () => {
    for (const href of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "java\tscript:alert(1)", " javascript:alert(1)", "data:text/html;base64,AAAA", "vbscript:x", "file:///etc/passwd"]) {
      expect(dropUnsafeLinks(`<a href="${href}">t</a>`)).toBe("<a>t</a>");
    }
  });
});

describe("convertDocx", () => {
  it("keeps the text of a document whose links are unsafe, drops those targets, and keeps markup-looking text as text", async () => {
    const md = await convertDocx(readFileSync(join(__dirname, "fixtures", "import", "links.docx")), async () => "/never");
    expect(md).not.toMatch(/javascript:/i);
    expect(md).not.toMatch(/data:text/i);
    expect(md).toContain("click me");
    expect(md).toContain("or me");
    // "<img ...>" typed in Word is words on the page, not an element: escaped for the markdown reader.
    expect(md).toContain("\\<img src=x onerror=alert(1)>");
  });
});
