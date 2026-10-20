import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConversionLimiter, ConversionRefused, convertInSandbox } from "../src/wiki/import/convert-sandbox";
import type { UploadImage } from "../src/wiki/import/types";

const fixture = (name: string) => join(__dirname, "fixtures", "import", name);
const store: UploadImage = async (image) => `/stored/${image.filename}:${image.buffer.length}`;

describe("convertInSandbox", () => {
  it("returns the worker's markdown and stores each image through the caller", async () => {
    const md = await convertInSandbox("docx", Buffer.alloc(10), store, { workerPath: fixture("echo-worker.cjs") });
    expect(md).toBe("docx:10:/stored/image-1.png:1000,/stored/image-2.png:2000,/stored/image-3.png:3000");
  });

  it("leaves out images past the count and size limits instead of failing the import", async () => {
    const stored: string[] = [];
    const md = await convertInSandbox(
      "docx",
      Buffer.alloc(1),
      async (i) => { stored.push(i.filename); return `/stored/${i.filename}`; },
      { workerPath: fixture("echo-worker.cjs"), maxImages: 2, maxImageBytes: 2500 },
    );
    // image 1 (1000 B) and 2 (2000 B) are stored; image 3 is over the count and over the size, so the worker is
    // told "no url" (the stand-in joins it as empty) and the import still completes.
    expect(stored).toEqual(["image-1.png", "image-2.png"]);
    expect(md).toBe("docx:1:/stored/image-1.png,/stored/image-2.png,");
  });

  it("leaves out one image that is over the size limit while the count is fine", async () => {
    const stored: string[] = [];
    const md = await convertInSandbox("docx", Buffer.alloc(1), async (i) => { stored.push(i.filename); return `/s/${i.filename}`; }, {
      workerPath: fixture("echo-worker.cjs"),
      maxImageBytes: 1500,
    });
    expect(stored).toEqual(["image-1.png"]);
    expect(md).toBe("docx:1:/s/image-1.png,,");
  });

  it("stops a worker that grows past the memory ceiling, and says so", async () => {
    const err = await convertInSandbox("pdf", Buffer.alloc(1), store, { workerPath: fixture("hog-worker.cjs"), maxRssBytes: 200 * 1024 * 1024, timeoutMs: 20_000 }).catch((e) => e);
    expect(err).toBeInstanceOf(ConversionRefused);
    expect(err.message).toMatch(/expands to far more/);
  }, 30_000);

  it("stops a worker that never answers", async () => {
    const err = await convertInSandbox("pdf", Buffer.alloc(1), store, { workerPath: fixture("spin-worker.cjs"), timeoutMs: 600 }).catch((e) => e);
    expect(err).toBeInstanceOf(ConversionRefused);
    expect(err.message).toMatch(/took too long/);
  }, 10_000);

  it("reports a worker that dies on its own", async () => {
    const err = await convertInSandbox("pdf", Buffer.alloc(1), store, { workerPath: fixture("crash-worker.cjs") }).catch((e) => e);
    expect(err).toBeInstanceOf(ConversionRefused);
    expect(err.message).toMatch(/stopped unexpectedly/);
  });

  it("passes on the converter's own complaint about a file", async () => {
    const err = await convertInSandbox("docx", Buffer.alloc(1), store, { workerPath: fixture("fail-worker.cjs") }).catch((e) => e);
    expect(err).toBeInstanceOf(ConversionRefused);
    expect(err.message).toBe("Couldn't read that file: not a zip file");
  });

  it("starts the child with an empty environment (it must never see the API's secrets)", () => {
    expect(readFileSync(join(__dirname, "../src/wiki/import/convert-sandbox.ts"), "utf8")).toMatch(/env: \{\}/);
  });

  it("runs at most the allowed number at once, queues a few, and turns the rest away as busy", async () => {
    const limiter = new ConversionLimiter(1, 1);
    let live = 0;
    let peak = 0;
    const job = () => limiter.run(async () => { live += 1; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 50)); live -= 1; return "ok"; });
    const results = await Promise.allSettled([job(), job(), job(), job()]);
    expect(peak).toBe(1);
    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(2); // one running, one waiting
    expect(refused).toHaveLength(2);
    for (const r of refused) {
      expect(r.reason).toBeInstanceOf(ConversionRefused);
      expect((r.reason as ConversionRefused).busy).toBe(true);
    }
    // the slots are free again afterwards
    await expect(limiter.run(async () => "again")).resolves.toBe("again");
  });

  it("frees its slot when a conversion fails", async () => {
    const limiter = new ConversionLimiter(1, 0);
    const err = await convertInSandbox("pdf", Buffer.alloc(1), store, { workerPath: fixture("crash-worker.cjs"), limiter }).catch((e) => e);
    expect(err).toBeInstanceOf(ConversionRefused);
    await expect(convertInSandbox("docx", Buffer.alloc(1), store, { workerPath: fixture("echo-worker.cjs"), limiter })).resolves.toMatch(/^docx:1:/);
  });
});
