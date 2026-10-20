import { describe, expect, it } from "vitest";
import { createSwitchModelSchema, setSwitchViewSchema, switchModelPortsSchema, updateSwitchModelSchema } from "@church/shared";
import { imageSize } from "../src/switch-models/image-size";

function png(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

function jpeg(w: number, h: number, withApp = true): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  if (withApp) {
    // An APP1 segment (EXIF) ahead of the frame header, as cameras write it.
    const app = Buffer.alloc(2 + 2 + 40);
    app.writeUInt8(0xff, 0);
    app.writeUInt8(0xe1, 1);
    app.writeUInt16BE(42, 2);
    parts.push(app);
  }
  const sof = Buffer.alloc(19);
  sof.writeUInt8(0xff, 0);
  sof.writeUInt8(0xc0, 1);
  sof.writeUInt16BE(17, 2);
  sof.writeUInt8(8, 4);
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  parts.push(sof);
  return Buffer.concat(parts);
}

function webpX(w: number, h: number): Buffer {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "ascii");
  b.write("WEBP", 8, "ascii");
  b.write("VP8X", 12, "ascii");
  b.writeUIntLE(w - 1, 24, 3);
  b.writeUIntLE(h - 1, 27, 3);
  return b;
}

function webpLossless(w: number, h: number): Buffer {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "ascii");
  b.write("WEBP", 8, "ascii");
  b.write("VP8L", 12, "ascii");
  b.writeUInt8(0x2f, 20);
  b.writeUInt32LE((w - 1) | ((h - 1) << 14), 21);
  return b;
}

function webpLossy(w: number, h: number): Buffer {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "ascii");
  b.write("WEBP", 8, "ascii");
  b.write("VP8 ", 12, "ascii");
  b.set([0x9d, 0x01, 0x2a], 23);
  b.writeUInt16LE(w, 26);
  b.writeUInt16LE(h, 28);
  return b;
}

describe("imageSize", () => {
  it("reads PNG, JPEG (past an EXIF block) and the three WebP encodings", () => {
    expect(imageSize(png(1800, 160))).toEqual({ width: 1800, height: 160, type: "image/png" });
    expect(imageSize(jpeg(2400, 220))).toEqual({ width: 2400, height: 220, type: "image/jpeg" });
    expect(imageSize(jpeg(640, 48, false))).toEqual({ width: 640, height: 48, type: "image/jpeg" });
    expect(imageSize(webpX(1600, 150))).toEqual({ width: 1600, height: 150, type: "image/webp" });
    expect(imageSize(webpLossless(1600, 150))).toEqual({ width: 1600, height: 150, type: "image/webp" });
    expect(imageSize(webpLossy(1600, 150))).toEqual({ width: 1600, height: 150, type: "image/webp" });
  });

  it("refuses anything else, and files that are cut short or claim an absurd size", () => {
    expect(imageSize(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"))).toBeNull();
    expect(imageSize(Buffer.from("GIF89a" + "\0".repeat(30), "latin1"))).toBeNull();
    expect(imageSize(Buffer.alloc(0))).toBeNull();
    expect(imageSize(png(1, 1).subarray(0, 20))).toBeNull();
    expect(imageSize(jpeg(10, 10).subarray(0, 12))).toBeNull();
    expect(imageSize(png(0, 50))).toBeNull();
    expect(imageSize(png(100000, 50))).toBeNull();
  });
});

const port = (name: string, over: Record<string, unknown> = {}) => ({ name, x: 0.1, y: 0.2, w: 0.02, h: 0.3, ...over });

describe("switch model schemas", () => {
  it("fills in the defaults for a new model", () => {
    expect(createSwitchModelSchema.parse({ name: "  Catalyst 3850  " })).toEqual({ name: "Catalyst 3850", match: [], portSide: "front" });
  });

  it("accepts ports, defaulting kind and aliases", () => {
    const [p] = switchModelPortsSchema.parse([port("Gi1/0/1")]);
    expect(p).toMatchObject({ name: "Gi1/0/1", kind: "rj45", aliases: [] });
  });

  it("refuses a port outside the picture or with no size", () => {
    expect(switchModelPortsSchema.safeParse([port("1", { x: 0.99 })]).success).toBe(false);
    expect(switchModelPortsSchema.safeParse([port("1", { y: 0.9, h: 0.3 })]).success).toBe(false);
    expect(switchModelPortsSchema.safeParse([port("1", { w: 0 })]).success).toBe(false);
    expect(switchModelPortsSchema.safeParse([port("1", { x: -0.1 })]).success).toBe(false);
  });

  it("gives each name to one port only, ignoring case, aliases included", () => {
    expect(switchModelPortsSchema.safeParse([port("Gi1/0/1"), port("gi1/0/1")]).success).toBe(false);
    expect(switchModelPortsSchema.safeParse([port("Gi1/1/1", { aliases: ["Te1/1/1"] }), port("Te1/1/1")]).success).toBe(false);
    expect(switchModelPortsSchema.safeParse([port("Gi1/1/1", { aliases: ["Te1/1/1"] }), port("Gi1/1/2", { aliases: ["Te1/1/2"] })]).success).toBe(true);
  });

  it("caps the number of ports", () => {
    const many = Array.from({ length: 257 }, (_, i) => port(`p${i}`));
    expect(switchModelPortsSchema.safeParse(many).success).toBe(false);
  });

  it("takes partial updates and short match strings only when long enough", () => {
    expect(updateSwitchModelSchema.safeParse({ portSide: "back" }).success).toBe(true);
    expect(updateSwitchModelSchema.safeParse({ portSide: "top" }).success).toBe(false);
    expect(updateSwitchModelSchema.safeParse({ match: ["x"] }).success).toBe(false);
    expect(updateSwitchModelSchema.safeParse({ match: ["C3850-48"] }).success).toBe(true);
  });
});

describe("setSwitchViewSchema", () => {
  const id = "3f2b8c1e-0a4d-4e57-9b1c-5d6e7f8a9b0c";
  it("takes auto and off alone, and a model only with its id", () => {
    expect(setSwitchViewSchema.safeParse({ mode: "auto" }).success).toBe(true);
    expect(setSwitchViewSchema.safeParse({ mode: "off" }).success).toBe(true);
    expect(setSwitchViewSchema.safeParse({ mode: "model", modelId: id }).success).toBe(true);
  });
  it("refuses a model with no id, an id with another mode, a bad id and an unknown mode", () => {
    expect(setSwitchViewSchema.safeParse({ mode: "model" }).success).toBe(false);
    expect(setSwitchViewSchema.safeParse({ mode: "auto", modelId: id }).success).toBe(false);
    expect(setSwitchViewSchema.safeParse({ mode: "off", modelId: id }).success).toBe(false);
    expect(setSwitchViewSchema.safeParse({ mode: "model", modelId: "not-a-uuid" }).success).toBe(false);
    expect(setSwitchViewSchema.safeParse({ mode: "sideways" }).success).toBe(false);
    expect(setSwitchViewSchema.safeParse({}).success).toBe(false);
  });
});
