import { describe, expect, it } from "vitest";
import { contentDisposition, filenameFromDisposition } from "../src/attachments/content-disposition";

describe("contentDisposition", () => {
  it("carries the real name in filename* and an ASCII stand-in in filename", () => {
    expect(contentDisposition("attachment", "My Report é.pdf")).toBe(
      `attachment; filename="My Report _.pdf"; filename*=UTF-8''My%20Report%20%C3%A9.pdf`,
    );
  });
  it("never lets a quote, backslash or line break out of the quoted name", () => {
    const h = contentDisposition("inline", 'a"b\\c\r\nd;e.png');
    expect(h.split("filename*")[0]).toBe('inline; filename="a_b_c__d_e.png"; ');
    expect(h).not.toMatch(/[\r\n]/);
  });
  it("round-trips through the parser, old and new forms", () => {
    expect(filenameFromDisposition(contentDisposition("attachment", "Weekly (v2) 'final'.docx"))).toBe("Weekly (v2) 'final'.docx");
    expect(filenameFromDisposition('attachment; filename="my%20file%C3%A9.txt"')).toBe("my fileé.txt");
    expect(filenameFromDisposition(undefined)).toBe("attachment");
  });
});
