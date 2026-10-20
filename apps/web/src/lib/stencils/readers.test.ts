import { describe, expect, it } from "vitest";
import { carveEmfs, dropLengthPrefix, productId, readVisioBinary, textRuns } from "./visio-binary";
import { readOfficeMedia, readPowerPointBinary } from "./ppt";
import { readVisioPackage } from "./vsdx";
import { dedupe, readStencilFile } from "./read-file";
import { readZip } from "./zip";
import { sniffPicture } from "./sniff";
import { StencilError } from "./types";
import { buildEmf, buildOle, buildVisioStencil, buildZip, bytes, u16, u32, utf16, zlib } from "./test-builders";

const text = (s: string) => new TextEncoder().encode(s);
const emfA = buildEmf([], [0, 0, 99, 49]);
const emfB = buildEmf([], [0, 0, 199, 49]);
const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], new Array(40).fill(0));

describe("binary Visio", () => {
  it("finds the picture of a master and names it from the master's own text", () => {
    const file = buildOle([{ name: "VisioDocument", data: buildVisioStencil({ id: "WS-C0000-24", description: "Stackable 24 ports", emf: emfA }) }]);
    const r = readVisioBinary(file, "test.vss");
    expect(r.pictures).toHaveLength(1);
    const p = r.pictures[0]!;
    expect(p.kind).toBe("emf");
    expect([...p.bytes]).toEqual([...emfA]);
    expect(p).toMatchObject({ name: "WS-C0000-24", description: "Stackable 24 ports", source: "test.vss, master 1" });
  });

  it("reads single-byte text (the older layout) as well as UTF-16", () => {
    const file = buildOle([{ name: "VisioDocument", data: buildVisioStencil({ id: "3650 48 PoE+", description: "Front Standalone", emf: emfA, utf16: false }) }]);
    expect(readVisioBinary(file, "old.vss").pictures[0]).toMatchObject({ name: "3650 48 PoE+", description: "Front Standalone" });
  });

  it("refuses a file that is not Visio, with a reason", () => {
    expect(() => readVisioBinary(new Uint8Array(100), "x")).toThrow(StencilError);
    const notVisio = buildOle([{ name: "VisioDocument", data: new Uint8Array(100) }]);
    expect(() => readVisioBinary(notVisio, "x")).toThrow(/not a Visio/);
    const wrongVersion = buildVisioStencil({ id: "A-B-1", description: "x", emf: emfA });
    wrongVersion[0x1a] = 3;
    expect(() => readVisioBinary(buildOle([{ name: "VisioDocument", data: wrongVersion }]), "x")).toThrow(/version 3/);
  });

  it("carves whole EMFs by their own header, and cleans length-prefixed text", () => {
    const junk = bytes(new Array(7).fill(0xaa), emfA, new Array(9).fill(0xbb), emfB);
    const found = carveEmfs(junk);
    expect(found.map((f) => f.length)).toEqual([emfA.length, emfB.length]);
    expect(carveEmfs(bytes(new Array(60).fill(0x20)))).toEqual([]);
    expect(textRuns(bytes(utf16("Hello there"), [0, 0xff], text("plain ascii run")))).toEqual(["Hello there", "plain ascii run"]);
    // a leading character that is the length of what follows is dropped
    expect(dropLengthPrefix("\x05hello")).toBe("hello");
    expect(dropLengthPrefix("hello")).toBe("hello");
    expect(productId("S" + "WS-C2960CX-8TC-L: 2960-CX Switch".padEnd(30, " "))).toBeTruthy();
    expect(productId("WS-C3850-24: Stackable 24 10/100/1000")).toBe("WS-C3850-24");
    expect(productId("`o3650 48 PoE+ 4x10G: Front Standalone")).toBe("3650 48 PoE+ 4x10G");
    expect(productId("no colon here")).toBeNull();
  });
});

describe("PowerPoint", () => {
  const blip = (type: number, instance: number, uidExtra: boolean, body: Uint8Array) => {
    const payload = bytes(new Array(16 + (uidExtra ? 16 : 0)).fill(1), body);
    return bytes(u16(instance << 4), u16(type), u32(payload.length), payload);
  };
  const metafileBody = (emf: Uint8Array, compress: boolean) => {
    const data = compress ? zlib(emf) : emf;
    return bytes(u32(emf.length), new Array(16).fill(0), new Array(8).fill(0), u32(data.length), [compress ? 0 : 0xfe, 0xfe], data);
  };

  it("reads the blips of a binary .ppt: compressed and plain metafiles, and bitmaps", async () => {
    const stream = bytes(
      blip(0xf01a, 0x3d4, false, metafileBody(emfA, true)),
      blip(0xf01a, 0x3d5, true, metafileBody(emfB, false)),
      blip(0xf01e, 0x6e0, false, bytes([0xff], PNG)),
      blip(0xf01c, 0x542, false, metafileBody(emfA, false)), // PICT: found, not drawable later
    );
    const file = buildOle([{ name: "Pictures", data: stream }, { name: "PowerPoint Document", data: new Uint8Array(10) }]);
    const r = await readPowerPointBinary(file, "art.ppt");
    expect(r.pictures.map((p) => p.kind)).toEqual(["emf", "emf", "png", "pict"]);
    expect([...r.pictures[0]!.bytes]).toEqual([...emfA]);
    expect([...r.pictures[1]!.bytes]).toEqual([...emfB]);
    expect([...r.pictures[2]!.bytes]).toEqual([...PNG]);
  });

  it("says so when there are no pictures", async () => {
    const file = buildOle([{ name: "PowerPoint Document", data: new Uint8Array(10) }]);
    const r = await readPowerPointBinary(file, "empty.ppt");
    expect(r.pictures).toHaveLength(0);
    expect(r.notes.join(" ")).toMatch(/no pictures/i);
  });

  it("reads the media of a .pptx and leaves files that are not pictures", async () => {
    const zip = buildZip([
      { name: "ppt/media/image1.emf", data: emfA },
      { name: "ppt/media/image2.png", data: PNG },
      { name: "ppt/media/readme.txt", data: text("hi") },
      { name: "ppt/slides/slide1.xml", data: text("<x/>") },
    ]);
    const r = await readOfficeMedia(readZip(zip), "art.pptx");
    expect(r.pictures.map((p) => [p.kind, p.name])).toEqual([["emf", "image1.emf"], ["png", "image2.png"]]);
  });
});

describe("Visio packages (.vsdx, .vssx)", () => {
  const xml = (s: string) => text(s);
  const masters = `<Masters xmlns:r='r'><Master ID='1' NameU='WS-A-1' Name='WS-A-1' Prompt='Front &amp; sides'><PageSheet/><Rel r:id='rId1'/></Master><Master ID='2' Name='NoPicture'><Rel r:id='rId2'/></Master></Masters>`;
  const mastersRels = `<Relationships><Relationship Id="rId1" Type="x" Target="master1.xml"/><Relationship Id='rId2' Target='master2.xml'/></Relationships>`;
  const master1 = `<MasterContents><Shapes><Shape><ForeignData ForeignType='EnhMetaFile' MappingMode='8'><Rel r:id='rId1'/></ForeignData></Shape></Shapes></MasterContents>`;
  const master1Rels = `<Relationships><Relationship Id="rId1" Target="../media/image2.emf"/></Relationships>`;

  it("pairs each master's name and prompt with its picture, and lists media nothing points at", async () => {
    const zip = buildZip([
      { name: "visio/masters/masters.xml", data: xml(masters) },
      { name: "visio/masters/_rels/masters.xml.rels", data: xml(mastersRels) },
      { name: "visio/masters/master1.xml", data: xml(master1) },
      { name: "visio/masters/_rels/master1.xml.rels", data: xml(master1Rels) },
      { name: "visio/masters/master2.xml", data: xml("<MasterContents/>") },
      { name: "visio/media/image2.emf", data: emfA },
      { name: "visio/media/image9.png", data: PNG },
    ]);
    const r = await readVisioPackage(readZip(zip), "pack.vssx");
    expect(r.pictures).toHaveLength(2);
    expect(r.pictures[0]).toMatchObject({ kind: "emf", name: "WS-A-1", description: "Front & sides", source: "pack.vssx, master 1" });
    expect(r.pictures[1]).toMatchObject({ kind: "png", name: null });
  });

  it("says when a package holds only drawn shapes", async () => {
    const zip = buildZip([{ name: "visio/masters/masters.xml", data: xml("<Masters/>") }]);
    const r = await readVisioPackage(readZip(zip), "shapes.vsdx");
    expect(r.pictures).toHaveLength(0);
    expect(r.notes.join(" ")).toMatch(/only drawn shapes/);
  });
});

describe("reading whatever file is given", () => {
  const vss = buildOle([{ name: "VisioDocument", data: buildVisioStencil({ id: "WS-A-1", description: "Front", emf: emfA }) }]);

  it("takes a plain picture as one picture named after the file", async () => {
    const r = await readStencilFile("Front view.png", PNG);
    expect(r.pictures).toHaveLength(1);
    expect(r.pictures[0]).toMatchObject({ kind: "png", name: "Front view" });
  });

  it("goes by the bytes, not the name", async () => {
    const r = await readStencilFile("picture.txt", PNG);
    expect(r.pictures[0]!.kind).toBe("png");
    await expect(readStencilFile("a.png", text("just some text"))).rejects.toThrow(/not a kind of file/);
  });

  it("reads a vendor zip: the Visio package first, the binary and PowerPoint copies named as skipped", async () => {
    const vssxZip = buildZip([
      { name: "visio/masters/masters.xml", data: text(`<Masters><Master ID='1' Name='FROM-VSSX'><Rel r:id='rId1'/></Master></Masters>`) },
      { name: "visio/masters/_rels/masters.xml.rels", data: text(`<Relationships><Relationship Id="rId1" Target="master1.xml"/></Relationships>`) },
      { name: "visio/masters/master1.xml", data: text(`<C><ForeignData><Rel r:id='rId1'/></ForeignData></C>`) },
      { name: "visio/masters/_rels/master1.xml.rels", data: text(`<Relationships><Relationship Id="rId1" Target="../media/image1.emf"/></Relationships>`) },
      { name: "visio/media/image1.emf", data: emfB },
    ]);
    const pack = buildZip([
      { name: "Switches.vssx", data: vssxZip },
      { name: "Switches.vss", data: vss },
      { name: "Switches_Art.ppt", data: buildOle([{ name: "Pictures", data: new Uint8Array(0) }, { name: "PowerPoint Document", data: new Uint8Array(4) }]) },
      { name: "Index.pdf", data: text("%PDF") },
    ]);
    const r = await readStencilFile("pack.zip", pack);
    expect(r.pictures.map((p) => p.name)).toEqual(["FROM-VSSX"]);
    expect(r.notes.join(" ")).toMatch(/Not read.*Switches\.vss/);
    expect(r.notes.join(" ")).toMatch(/Not read.*Switches_Art\.ppt/);
  });

  it("reads the binary stencil when it is the only Visio file, and falls back to PowerPoint when Visio gives nothing", async () => {
    const r = await readStencilFile("pack.zip", buildZip([{ name: "Switches.vss", data: vss }]));
    expect(r.pictures[0]).toMatchObject({ name: "WS-A-1" });
    const ppt = buildOle([{ name: "Pictures", data: bytes(u16(0x3d4 << 4), u16(0xf01a), u32(16 + 34 + emfA.length), new Array(16).fill(1), u32(emfA.length), new Array(28).fill(0), [0xfe, 0xfe], emfA) }, { name: "PowerPoint Document", data: new Uint8Array(4) }]);
    const r2 = await readStencilFile("pack.zip", buildZip([{ name: "Art.ppt", data: ppt }]));
    expect(r2.pictures).toHaveLength(1);
  });

  it("says what a zip with nothing useful holds, and refuses a zip inside a zip inside a zip", async () => {
    await expect(readStencilFile("empty.zip", buildZip([{ name: "notes.txt", data: text("x") }]))).rejects.toThrow(/no Visio, PowerPoint or picture/);
    const inner = buildZip([{ name: "a.png", data: PNG }]);
    const mid = buildZip([{ name: "inner.zip", data: inner }]);
    const r = await readStencilFile("outer.zip", buildZip([{ name: "mid.zip", data: mid }]));
    expect(r.pictures).toHaveLength(0);
    expect(r.notes.join(" ")).toMatch(/zip inside a zip/);
  });

  it("leaves out identical pictures, keeping the first name that has one", () => {
    const mk = (id: string, name: string | null, b: Uint8Array) => ({ id, kind: "emf" as const, bytes: b, name, description: null, source: id });
    const r = dedupe({ pictures: [mk("1", null, emfA), mk("2", "Named", emfA), mk("3", "Other", emfB)], notes: [] });
    expect(r.pictures.map((p) => p.name)).toEqual(["Named", "Other"]);
    expect(r.notes.join(" ")).toMatch(/1 picture was left out/);
  });
});

describe("telling pictures apart by their bytes", () => {
  it("recognises the kinds it knows", () => {
    expect(sniffPicture(PNG)).toBe("png");
    expect(sniffPicture(bytes([0xff, 0xd8, 0xff, 0xe0], new Array(10).fill(0)))).toBe("jpeg");
    expect(sniffPicture(emfA)).toBe("emf");
    expect(sniffPicture(bytes([0xd7, 0xcd, 0xc6, 0x9a], new Array(10).fill(0)))).toBe("wmf");
    expect(sniffPicture(text('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe("svg");
    expect(sniffPicture(text("<html><svg/></html>"))).toBeNull();
    expect(sniffPicture(text("plain text file contents"))).toBeNull();
  });
});
