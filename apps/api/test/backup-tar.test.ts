import { describe, expect, it } from "vitest";
import { PassThrough, Readable } from "node:stream";
import { createGzip, createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { randomBytes } from "node:crypto";
import { TarWriter, readTar } from "../src/backup/tar";

async function collect(write: (w: TarWriter) => Promise<void>): Promise<Buffer> {
  const out = new PassThrough();
  const parts: Buffer[] = [];
  out.on("data", (c: Buffer) => parts.push(c));
  const w = new TarWriter(out);
  await write(w);
  await w.finish();
  out.end();
  await new Promise((r) => out.on("end", r));
  return Buffer.concat(parts);
}

async function* chunked(buf: Buffer, size: number): AsyncGenerator<Buffer> {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}

describe("tar writer and reader", () => {
  it("round-trips entries of awkward sizes, in order", async () => {
    const sizes = [0, 1, 511, 512, 513, 1024, 4097];
    const payloads = sizes.map((n) => randomBytes(n));
    const archive = await collect(async (w) => {
      for (const [i, p] of payloads.entries()) await w.addBuffer(`f/${i}`, p);
    });
    expect(archive.length % 512).toBe(0);
    const seen: Array<{ name: string; data: Buffer }> = [];
    for await (const e of readTar(chunked(archive, 700))) seen.push({ name: e.name, data: await e.buffer() });
    expect(seen.map((s) => s.name)).toEqual(sizes.map((_, i) => `f/${i}`));
    seen.forEach((s, i) => expect(s.data.equals(payloads[i]!)).toBe(true));
  });

  it("keeps names longer than 100 bytes (PAX) and non-ASCII names", async () => {
    const long = `files/attachments/${"x".repeat(150)}/${"é".repeat(30)}.png`;
    const archive = await collect(async (w) => {
      await w.addBuffer(long, Buffer.from("hello"));
      await w.addBuffer("short.txt", Buffer.from("after"));
    });
    const names: string[] = [];
    for await (const e of readTar(chunked(archive, 4096))) {
      names.push(e.name);
      await e.buffer();
    }
    expect(names).toEqual([long, "short.txt"]);
  });

  it("streams a large entry without holding it, and skips entries nobody reads", async () => {
    const big = randomBytes(3 * 1024 * 1024 + 17);
    const archive = await collect(async (w) => {
      await w.addStream("big", big.length, chunked(big, 65536));
      await w.addBuffer("small", Buffer.from("tail"));
    });
    const iter = readTar(chunked(archive, 10000));
    const first = await iter.next();
    expect(first.value!.name).toBe("big");
    expect(first.value!.size).toBe(big.length);
    // Not read: the reader steps over it.
    const second = await iter.next();
    expect(second.value!.name).toBe("small");
    expect((await second.value!.buffer()).toString()).toBe("tail");
    expect((await iter.next()).done).toBe(true);
  });

  it("refuses a stream whose length differs from the announced size", async () => {
    await expect(
      collect(async (w) => {
        await w.addStream("short", 100, chunked(randomBytes(50), 10));
      }),
    ).rejects.toThrow(/50 bytes instead of the 100/);
    await expect(
      collect(async (w) => {
        await w.addStream("long", 10, chunked(randomBytes(50), 10));
      }),
    ).rejects.toThrow(/more data than/);
  });

  it("detects a damaged header and a truncated archive", async () => {
    const archive = await collect(async (w) => {
      await w.addBuffer("a", randomBytes(2000));
    });
    const damaged = Buffer.from(archive);
    damaged[10] = damaged[10]! ^ 0xff;
    await expect((async () => { for await (const e of readTar(chunked(damaged, 512))) await e.buffer(); })()).rejects.toThrow(/checksum/);
    const truncated = archive.subarray(0, 1200);
    await expect((async () => { for await (const e of readTar(chunked(truncated, 512))) await e.buffer(); })()).rejects.toThrow(/ends inside an entry/);
  });

  it("works through gzip like a real backup", async () => {
    const out = new PassThrough();
    const gz = createGzip();
    const chunks: Buffer[] = [];
    const sink = new PassThrough();
    sink.on("data", (c: Buffer) => chunks.push(c));
    const done = pipeline(out, gz, sink);
    const w = new TarWriter(out);
    await w.addBuffer("manifest.json", Buffer.from(JSON.stringify({ hello: "world" })));
    await w.addBuffer("tables/x/000001.ndjson", Buffer.from('{"a":1}\n{"a":2}\n'));
    await w.finish();
    out.end();
    await done;
    const names: string[] = [];
    for await (const e of readTar(Readable.from(Buffer.concat(chunks)).pipe(createGunzip()))) {
      names.push(e.name);
      await e.buffer();
    }
    expect(names).toEqual(["manifest.json", "tables/x/000001.ndjson"]);
  });
});
