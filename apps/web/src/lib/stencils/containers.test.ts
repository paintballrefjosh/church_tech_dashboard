import { describe, expect, it } from "vitest";
import { visioDecompress } from "./lzss";
import { isOle, readOle } from "./ole";
import { isZip, readZip } from "./zip";
import { buildOle, buildZip, bytes, literalLzss } from "./test-builders";

const text = (s: string) => new TextEncoder().encode(s);

describe("Visio compression", () => {
  it("decodes literal items", () => {
    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect([...visioDecompress(literalLzss(data))]).toEqual([...data]);
  });

  it("decodes a copy from the ring, including one that overlaps what it is writing", () => {
    // three literals "abc", then a 9-byte copy from ring position 0 (stored as 4078): "abc" repeated
    const src = new Uint8Array([0b00000111, 0x61, 0x62, 0x63, 0xee, 0xf6]);
    expect(new TextDecoder().decode(visioDecompress(src))).toBe("abcabcabcabc");
  });

  it("never writes past its cap, and stops cleanly at a cut-off item", () => {
    expect(visioDecompress(literalLzss(new Uint8Array(100).fill(9)), 10)).toHaveLength(10);
    expect([...visioDecompress(new Uint8Array([0b00000001, 0x41, 0xee]))]).toEqual([0x41]);
  });
});

describe("OLE compound files", () => {
  it("reads small streams (the mini stream) and large ones by name", () => {
    const big = new Uint8Array(6000).map((_, i) => i % 251);
    const file = buildOle([
      { name: "Small", data: text("hello mini stream") },
      { name: "Big", data: big },
      { name: "Tiny", data: new Uint8Array([1, 2, 3]) },
    ]);
    expect(isOle(file)).toBe(true);
    const ole = readOle(file);
    expect(ole.streams.map((s) => s.name).sort()).toEqual(["Big", "Small", "Tiny"]);
    expect(new TextDecoder().decode(ole.read("Small")!)).toBe("hello mini stream");
    expect([...ole.read("Tiny")!]).toEqual([1, 2, 3]);
    expect([...ole.read("Big")!]).toEqual([...big]);
    expect(ole.read("Missing")).toBeNull();
  });

  it("refuses what is not a compound file, and survives a damaged one", () => {
    expect(isOle(text("PK"))).toBe(false);
    expect(() => readOle(new Uint8Array(1024))).toThrow(/not an OLE/);
    const file = buildOle([{ name: "Big", data: new Uint8Array(6000).fill(5) }]);
    // cut the file short: the stream is shorter, never a loop or a crash
    const cut = readOle(file.slice(0, 2000));
    expect(cut.read("Big")!.length).toBeLessThanOrEqual(6000);
  });
});

describe("zip files", () => {
  it("lists entries and reads stored and deflated ones", async () => {
    const zip = buildZip([
      { name: "a.txt", data: text("stored text"), store: true },
      { name: "dir/b.txt", data: text("deflated ".repeat(200)) },
    ]);
    expect(isZip(zip)).toBe(true);
    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual(["a.txt", "dir/b.txt"]);
    expect(new TextDecoder().decode(await entries[0]!.read())).toBe("stored text");
    expect(new TextDecoder().decode(await entries[1]!.read())).toBe("deflated ".repeat(200));
  });

  it("stops an entry that inflates to more than the zip said", async () => {
    const zip = buildZip([{ name: "bomb.bin", data: new Uint8Array(2_000_000), lieAboutSize: 100 }]);
    await expect(readZip(zip)[0]!.read()).rejects.toThrow(/inflates to more/);
  });

  it("refuses an entry larger than the cap before inflating it", async () => {
    const zip = buildZip([{ name: "big.bin", data: new Uint8Array(1000) }]);
    await expect(readZip(zip, { maxEntryBytes: 100 })[0]!.read()).rejects.toThrow(/larger than/);
  });

  it("refuses a zip with too many entries, and one that is not a zip", () => {
    const many = buildZip(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}`, data: text("x"), store: true })));
    expect(() => readZip(many, { maxEntries: 3 })).toThrow(/more than/);
    expect(() => readZip(bytes([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]))).toThrow(/not a zip/);
  });
});
