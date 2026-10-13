import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_TYPE_CATALOGUE,
  DEFAULT_ATTACHMENT_TYPES,
  MAX_CUSTOM_ATTACHMENT_EXTENSIONS,
  normaliseCustomExtension,
  resolveAllowedAttachmentTypes,
  resolveCustomAttachmentExtensions,
  validateSettingValue,
} from "@church/shared";
import { reconcileMime } from "../src/attachments/magic-bytes";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const zipHead = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const oleHead = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0, 0, 0, 0, 0]);
const pngHead = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
const htmlHead = Buffer.from("<html><script>alert(1)</script>");

describe("attachment type catalogue", () => {
  it("never offers script-capable or catch-all types", () => {
    const mimes = ATTACHMENT_TYPE_CATALOGUE.map((t) => t.mime);
    for (const bad of ["text/html", "image/svg+xml", "application/octet-stream", "application/xhtml+xml", "text/javascript"]) {
      expect(mimes).not.toContain(bad);
    }
    expect(new Set(mimes).size).toBe(mimes.length);
  });

  it("defaults are all catalogue entries and keep the previous behaviour (no Excel yet)", () => {
    const mimes = ATTACHMENT_TYPE_CATALOGUE.map((t) => t.mime);
    expect(DEFAULT_ATTACHMENT_TYPES.every((m) => mimes.includes(m))).toBe(true);
    expect(DEFAULT_ATTACHMENT_TYPES).not.toContain(XLSX);
  });
});

describe("resolveAllowedAttachmentTypes", () => {
  it("uses the defaults when nothing valid is stored, and honours an empty list", () => {
    expect(resolveAllowedAttachmentTypes(undefined)).toEqual([...DEFAULT_ATTACHMENT_TYPES]);
    expect(resolveAllowedAttachmentTypes("png")).toEqual([...DEFAULT_ATTACHMENT_TYPES]);
    expect(resolveAllowedAttachmentTypes([])).toEqual([]);
  });

  it("drops anything outside the catalogue, even if it was stored", () => {
    expect(resolveAllowedAttachmentTypes([XLSX, "text/html", "image/svg+xml", "image/png"]).sort()).toEqual(
      ["image/png", XLSX].sort(),
    );
  });
});

describe("validateSettingValue attachments.allowed_types", () => {
  it("accepts catalogue types and rejects the rest", () => {
    expect(validateSettingValue("attachments.allowed_types", [XLSX, "image/png"])).toBeNull();
    expect(validateSettingValue("attachments.allowed_types", [])).toBeNull();
    expect(validateSettingValue("attachments.allowed_types", ["text/html"])).not.toBeNull();
    expect(validateSettingValue("attachments.allowed_types", "image/png")).not.toBeNull();
    expect(validateSettingValue("attachments.allowed_types", [1])).not.toBeNull();
  });
});

describe("reconcileMime", () => {
  it("accepts an xlsx that is a zip container, refuses other bytes under that type", () => {
    expect(reconcileMime(XLSX, zipHead)).toBe(XLSX);
    expect(() => reconcileMime(XLSX, pngHead)).toThrow(/doesn't match/);
    expect(() => reconcileMime(XLSX, htmlHead)).toThrow(/no magic bytes/);
  });

  it("accepts legacy Office files only as OLE containers", () => {
    expect(reconcileMime("application/vnd.ms-excel", oleHead)).toBe("application/vnd.ms-excel");
    expect(() => reconcileMime("application/vnd.ms-excel", zipHead)).toThrow(/doesn't match/);
    expect(() => reconcileMime("application/msword", pngHead)).toThrow(/doesn't match/);
  });

  it("keeps the exact-match rule for images and the plain-text trust", () => {
    expect(reconcileMime("image/png", pngHead)).toBe("image/png");
    expect(() => reconcileMime("image/jpeg", pngHead)).toThrow(/doesn't match/);
    expect(reconcileMime("text/csv", htmlHead)).toBe("text/csv");
    expect(reconcileMime("application/zip", zipHead)).toBe("application/zip");
    expect(() => reconcileMime("application/zip", oleHead)).toThrow();
  });

  it("refuses a type outside the catalogue", () => {
    expect(() => reconcileMime("text/html", htmlHead)).toThrow(/not a supported/);
    expect(() => reconcileMime("application/octet-stream", zipHead)).toThrow(/not a supported/);
  });
});

describe("custom attachment extensions", () => {
  it("normalises what an admin types", () => {
    for (const typed of ["dwg", ".DWG", " *.dwg ", "..dwg"]) {
      expect(normaliseCustomExtension(typed)).toEqual({ ok: true, ext: "dwg" });
    }
  });

  it("refuses anything that is not a plain extension", () => {
    for (const bad of ["", ".", "tar.gz", "dw g", "a/b", "waytoolongext", "d wg", "dwg;", "é"]) {
      expect(normaliseCustomExtension(bad).ok).toBe(false);
    }
  });

  it("refuses extensions that run code in a browser or on a computer", () => {
    for (const bad of ["html", ".HTM", "svg", "xml", "js", "exe", "bat", "ps1", "jar", "sh", "php", "hta", "msi"]) {
      const r = normaliseCustomExtension(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/run code/);
    }
  });

  it("refuses extensions the checklist covers, so unticking a type cannot be undone here", () => {
    for (const covered of ["xlsx", "png", "jpg", "jpeg", "pdf", "docx", "zip", "csv"]) {
      const r = normaliseCustomExtension(covered);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/checklist/);
    }
  });

  it("never lets a catalogue extension or a blocked one through, whatever is stored", () => {
    expect(resolveCustomAttachmentExtensions(["dwg", ".VSDX", "html", "xlsx", "dwg", 7, null, "x y"])).toEqual([
      "dwg",
      "vsdx",
    ]);
    expect(resolveCustomAttachmentExtensions("dwg")).toEqual([]);
    expect(resolveCustomAttachmentExtensions(undefined)).toEqual([]);
    const many = Array.from({ length: 80 }, (_, i) => `e${i}`);
    expect(resolveCustomAttachmentExtensions(many)).toHaveLength(MAX_CUSTOM_ATTACHMENT_EXTENSIONS);
  });

  it("validates the setting value with a reason", () => {
    const v = (x: unknown) => validateSettingValue("attachments.custom_extensions", x);
    expect(v(["dwg", "vsdx"])).toBeNull();
    expect(v([])).toBeNull();
    expect(v(["dwg", "exe"])).toMatch(/exe/);
    expect(v("dwg")).not.toBeNull();
    expect(v([5])).not.toBeNull();
    expect(v(Array.from({ length: 51 }, (_, i) => `e${i}`))).toMatch(/At most/);
  });
});
