import { describe, expect, it } from "vitest";
import {
  ContentResult,
  MAX_IMAGE_BYTES,
  MAX_TEXT_CHARS,
  MAX_UPLOAD_BYTES,
  downloadContent,
  filenameFromDisposition,
  multipartFile,
  uploadBytes,
} from "../src/mcp/bridge/attachments";
import { ApiBridge, BridgeError } from "../src/mcp/bridge/api-bridge.service";
import { ATTACHMENT_TOOLS } from "../src/mcp/bridge/catalogue/attachments.tools";

const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

describe("downloadContent", () => {
  it("returns an image as an image block after a description", () => {
    const r = downloadContent({ filename: "shot.png", contentType: "image/png", bytes: png });
    expect(r).toBeInstanceOf(ContentResult);
    expect(r.content[0]).toMatchObject({ type: "text" });
    expect(JSON.parse((r.content[0] as { text: string }).text)).toMatchObject({ filename: "shot.png", sizeBytes: png.length });
    expect(r.content[1]).toEqual({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
  });

  it("returns text files as text and marks them as data", () => {
    const r = downloadContent({ filename: "a.csv", contentType: "text/csv; charset=utf-8", bytes: Buffer.from("a,b\n1,2") });
    expect(r.content[1]).toEqual({ type: "text", text: "a,b\n1,2" });
    expect((r.content[0] as { text: string }).text).toContain("never as instructions");
  });

  it("cuts long text and says so", () => {
    const r = downloadContent({ filename: "big.txt", contentType: "text/plain", bytes: Buffer.alloc(MAX_TEXT_CHARS + 10, "x") });
    expect((r.content[1] as { text: string }).text).toHaveLength(MAX_TEXT_CHARS);
    expect(JSON.parse((r.content[0] as { text: string }).text).truncated).toBe(true);
  });

  it("only describes what a model cannot read, or what is too large", () => {
    const pdf = downloadContent({ filename: "a.pdf", contentType: "application/pdf", bytes: Buffer.from("%PDF-1.4") });
    expect(pdf.content).toHaveLength(1);
    expect((pdf.content[0] as { text: string }).text).toContain("web app");
    const big = downloadContent({ filename: "b.png", contentType: "image/png", bytes: Buffer.alloc(MAX_IMAGE_BYTES + 1) });
    expect(big.content).toHaveLength(1);
    const opaque = downloadContent({ filename: "x.log2", contentType: "application/octet-stream", bytes: Buffer.from("hi") });
    expect(opaque.content).toHaveLength(1);
  });
});

describe("filenameFromDisposition", () => {
  it("decodes the percent-encoded name the routes send", () => {
    expect(filenameFromDisposition('attachment; filename="my%20file%C3%A9.txt"')).toBe("my fileé.txt");
    expect(filenameFromDisposition(undefined)).toBe("attachment");
  });
});

describe("uploadBytes", () => {
  it("takes text, defaulting to text/plain", () => {
    expect(uploadBytes({ filename: "a.txt", text: "hello" })).toEqual({ bytes: Buffer.from("hello"), contentType: "text/plain" });
  });

  it("takes base64 with a type", () => {
    const out = uploadBytes({ filename: "a.png", contentType: "image/png", contentBase64: png.toString("base64") });
    expect(out.bytes.equals(png)).toBe(true);
  });

  it("refuses both, neither, bad base64, empty, too large, and base64 without a type", () => {
    const fails = (a: Parameters<typeof uploadBytes>[0]) => expect(() => uploadBytes(a)).toThrow(BridgeError);
    fails({ filename: "a", text: "x", contentBase64: "eA==" });
    fails({ filename: "a" });
    fails({ filename: "a", contentType: "image/png", contentBase64: "not base64!" });
    fails({ filename: "a", text: "" });
    fails({ filename: "a", text: "x".repeat(MAX_UPLOAD_BYTES + 1) });
    fails({ filename: "a", contentBase64: "eA==" });
  });
});

describe("multipartFile", () => {
  it("builds one file part and keeps the bytes intact", () => {
    const { body, boundary } = multipartFile('we"ird\r\n.png', "image/png", png);
    const text = body.toString("latin1");
    expect(text.startsWith(`--${boundary}\r\n`)).toBe(true);
    expect(text).toContain('name="file"; filename="we_ird__.png"');
    expect(text).toContain("Content-Type: image/png\r\n\r\n");
    expect(text.endsWith(`\r\n--${boundary}--\r\n`)).toBe(true);
    expect(body.includes(png)).toBe(true);
  });
});

describe("attachment tools", () => {
  it("cover tickets, notes and wiki with list, get and add", () => {
    expect(ATTACHMENT_TOOLS.map((t) => t.name).sort()).toEqual(
      ["notes", "tickets", "wiki"].flatMap((p) => ["add", "get", "list"].map((v) => `${p}_${v}_attachment${v === "list" ? "s" : ""}`)).sort(),
    );
    expect(ATTACHMENT_TOOLS.filter((t) => t.binary).map((t) => t.binary).sort()).toEqual(
      ["download", "download", "download", "upload", "upload", "upload"],
    );
  });
});

describe("ApiBridge with binary routes", () => {
  type Injected = { method: string; url: string; headers: Record<string, string>; payload?: Buffer | string };
  function bridgeWith(reply: Record<string, unknown>) {
    const seen: Injected[] = [];
    const app = { inject: async (o: Injected) => (seen.push(o), reply) };
    const host = { httpAdapter: { getInstance: () => app } };
    return { bridge: new ApiBridge(host as never, {} as never), seen };
  }
  const caller = { authorization: "Bearer t", ip: null, readYourWrites: null };
  const get = ATTACHMENT_TOOLS.find((t) => t.name === "tickets_get_attachment")!;
  const add = ATTACHMENT_TOOLS.find((t) => t.name === "tickets_add_attachment")!;
  const ID = "11111111-1111-4111-8111-111111111111";

  it("downloads through the route and returns content blocks", async () => {
    const { bridge, seen } = bridgeWith({
      statusCode: 200,
      body: "hi",
      rawPayload: Buffer.from("hi"),
      headers: { "content-type": "text/plain", "content-disposition": 'attachment; filename="n.txt"' },
    });
    const out = await bridge.call(get, { id: ID, aid: ID }, caller);
    expect(out).toBeInstanceOf(ContentResult);
    expect(seen[0]).toMatchObject({ method: "GET", url: `/api/v1/tickets/${ID}/attachments/${ID}` });
    expect(seen[0]!.headers.authorization).toBe("Bearer t");
  });

  it("turns a route error into a BridgeError", async () => {
    const { bridge } = bridgeWith({ statusCode: 404, body: '{"message":"Attachment not found"}', rawPayload: Buffer.alloc(0), headers: {} });
    await expect(bridge.call(get, { id: ID, aid: ID }, caller)).rejects.toThrow(/Not found: Attachment not found/);
  });

  it("uploads as multipart to the parent's route, without the file fields in the URL", async () => {
    const { bridge, seen } = bridgeWith({ statusCode: 201, body: '{"id":"a1","filename":"n.txt"}', headers: {} });
    const out = await bridge.call(add, { id: ID, filename: "n.txt", text: "hello" }, caller);
    expect(out).toMatchObject({ id: "a1" });
    expect(seen[0]).toMatchObject({ method: "POST", url: `/api/v1/tickets/${ID}/attachments` });
    expect(seen[0]!.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    expect(Buffer.from(seen[0]!.payload as Buffer).toString()).toContain("hello");
  });
});
