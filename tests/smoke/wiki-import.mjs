/**
 * Wiki file import smoke tests, run from run.mjs: .txt, .docx and .pdf into a new page, and the files the importer must
 * refuse. The docx and pdf bombs are a few hundred KB that would inflate to a GiB inside the parser; the importer
 * reads them in a child process with a memory ceiling (apps/api/src/wiki/import/convert-sandbox.ts), so the answer is a plain
 * 400 and the API keeps serving. Everything made here is deleted before the block ends.
 */
import { readFileSync } from "node:fs";
import { createDeflate, createDeflateRaw, deflateRawSync } from "node:zlib";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/** Deflates `prefix` followed by `chunk` repeated `times`, without ever holding the expanded bytes. */
async function deflateRepeated(raw, prefix, chunk, times) {
  const z = raw ? createDeflateRaw({ level: 9 }) : createDeflate({ level: 9 });
  const out = [];
  z.on("data", (d) => out.push(d));
  const ended = new Promise((resolve, reject) => { z.on("end", resolve); z.on("error", reject); });
  let crc = 0;
  let size = 0;
  const feed = async (b) => { crc = crc32(b, crc); size += b.length; if (!z.write(b)) await new Promise((r) => z.once("drain", r)); };
  if (prefix.length) await feed(prefix);
  for (let i = 0; i < times; i++) await feed(chunk);
  z.end();
  await ended;
  return { data: Buffer.concat(out), crc, size };
}

/** A zip with each entry deflated; `entries` hold either { name, text } or { name, deflated: {data, crc, size} }. */
function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const d = e.deflated;
    const body = d ? d.data : Buffer.from(e.text);
    const rawLen = d ? d.size : body.length;
    const crc = d ? d.crc : crc32(body);
    const comp = d ? d.data : deflateRawSync(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(rawLen, 22); local.writeUInt16LE(name.length, 26);
    locals.push(local, name, comp);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(rawLen, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += local.length + name.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, end]);
}
const CT = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
const RELS = '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const doc = (inner) => `<?xml version="1.0" encoding="UTF-8"?><w:document ${NS}><w:body>${inner}</w:body></w:document>`;
const rels = (inner) => `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${inner}</Relationships>`;


/** A one-page PDF whose content stream is the given (already Flate-compressed) bytes. */
function pdfWith(compressed) {
  const objs = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>"),
    Buffer.concat([Buffer.from(`<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`), compressed, Buffer.from("\nendstream")]),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
  ];
  const parts = [Buffer.from("%PDF-1.4\n")];
  const offsets = [];
  let at = parts[0].length;
  objs.forEach((o, i) => { offsets.push(at); const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), o, Buffer.from("\nendobj\n")]); parts.push(b); at += b.length; });
  const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`), `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`].join("");
  parts.push(Buffer.from(xref));
  return Buffer.concat(parts);
}
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

export async function wikiImportTests({ test, assert, fetchWithCookies, jar }) {
  const session = (path, init = {}) => fetchWithCookies(path, init, jar);
  const made = [];
  const importFile = async (title, name, type, bytes) => {
    const fd = new FormData();
    fd.append("file", new Blob([bytes], { type }), name);
    return session(`/api/v1/wiki/import?title=${encodeURIComponent(title)}`, { method: "POST", body: fd });
  };
  const keep = async (res) => { const p = await res.json(); if (p?.id) made.push(p.id); return p; };
  const pageCount = async () => (await (await session("/api/v1/wiki")).res.json()).length;

  try {
    await test("wiki import: a .txt becomes a page, paragraphs kept", async () => {
      const { res } = await importFile("[smoke] import txt", "notes.txt", "text/plain", Buffer.from("First paragraph.\n\nSecond one.\n- not a list"));
      assert(res.status === 200 || res.status === 201, `status ${res.status}`);
      const p = await keep(res);
      assert(p.body.includes("First paragraph.") && p.body.includes("\\- not a list"), `body: ${p.body}`);
    });

    await test("wiki import: a .docx keeps its words, loses javascript:/data: link targets, and shows typed markup as text", async () => {
      const bytes = zip([
        { name: "[Content_Types].xml", text: CT },
        { name: "_rels/.rels", text: RELS },
        { name: "word/_rels/document.xml.rels", text: rels('<Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:alert(document.cookie)" TargetMode="External"/><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/ok" TargetMode="External"/>') },
        { name: "word/document.xml", text: doc('<w:p><w:hyperlink r:id="rId7"><w:r><w:t>click me</w:t></w:r></w:hyperlink> <w:hyperlink r:id="rId9"><w:r><w:t>good link</w:t></w:r></w:hyperlink><w:r><w:t> &lt;img src=x onerror=alert(1)&gt;</w:t></w:r></w:p>') },
      ]);
      const { res } = await importFile("[smoke] import docx", "links.docx", DOCX, bytes);
      assert(res.status === 200 || res.status === 201, `status ${res.status}: ${await res.clone().text()}`);
      const p = await keep(res);
      assert(p.body.includes("click me") && !/javascript:/i.test(p.body), `unsafe link survived: ${p.body}`);
      assert(p.body.includes("[good link](https://example.com/ok)"), `good link lost: ${p.body}`);
      assert(p.body.includes("\\<img"), `typed markup became real markup: ${p.body}`);
    });

    await test("wiki import: a .docx with a picture stores the picture as an attachment and links it", async () => {
      const bytes = zip([
        { name: "[Content_Types].xml", text: CT },
        { name: "_rels/.rels", text: RELS },
        { name: "word/_rels/document.xml.rels", text: rels('<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>') },
        { name: "word/document.xml", text: doc('<w:p><w:r><w:t>Before</w:t></w:r></w:p><w:p><w:r><w:drawing><wp:inline><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rId5"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>') },
        { name: "word/media/image1.png", deflated: { data: deflateRawSync(PNG), crc: crc32(PNG), size: PNG.length } },
      ]);
      const { res } = await importFile("[smoke] import docx picture", "picture.docx", DOCX, bytes);
      assert(res.status === 200 || res.status === 201, `status ${res.status}: ${await res.clone().text()}`);
      const p = await keep(res);
      const m = /!\[[^\]]*\]\(\/api\/wiki\/([0-9a-f-]+)\/attachments\/([0-9a-f-]+)\)/.exec(p.body);
      assert(m && m[1] === p.id, `no link to the stored picture: ${p.body}`);
      const { res: dl } = await session(`/api/v1/wiki/${p.id}/attachments/${m[2]}`);
      assert(dl.status === 200 && dl.headers.get("content-type") === "image/png", `picture download: ${dl.status} ${dl.headers.get("content-type")}`);
      assert(Buffer.from(await dl.arrayBuffer()).equals(PNG), "stored picture differs from the one in the document");
    });

    await test("wiki import: a small .pdf (made by a browser, one line of text) gives its text", async () => {
      const bytes = readFileSync(new URL("./fixtures/small.pdf", import.meta.url));
      const { res } = await importFile("[smoke] import pdf", "small.pdf", "application/pdf", bytes);
      assert(res.status === 200 || res.status === 201, `status ${res.status}: ${await res.clone().text()}`);
      const p = await keep(res);
      assert(p.body.includes("Smoke import words"), `text missing: ${p.body}`);
    });

    await test("wiki import: a damaged .docx is refused with a plain message and leaves no page", async () => {
      const before = await pageCount();
      const { res } = await importFile("[smoke] import damaged", "broken.docx", DOCX, Buffer.from("this is not a zip file at all"));
      assert(res.status === 400, `status ${res.status}`);
      assert(/Couldn't read that file/.test((await res.json()).message ?? ""), "message should say the file could not be read");
      assert((await pageCount()) === before, "a page was left behind");
    });

    // ~1 GiB inflated each. Without the sandbox the API process itself would be asked for that much memory.
    const GIB_MB = 1024;
    const zeros = Buffer.alloc(1024 * 1024);
    await test("wiki import: a .docx that inflates to a GiB is refused, the API keeps serving and no page is left", async () => {
      const before = await pageCount();
      const png = await deflateRepeated(true, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), zeros, GIB_MB);
      const bytes = zip([
        { name: "[Content_Types].xml", text: CT },
        { name: "_rels/.rels", text: RELS },
        { name: "word/_rels/document.xml.rels", text: rels('<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>') },
        { name: "word/document.xml", text: doc('<w:p><w:r><w:drawing><wp:inline><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rId5"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>') },
        { name: "word/media/image1.png", deflated: png },
      ]);
      assert(bytes.length < 5 * 1024 * 1024, `the bomb should be small (${bytes.length} bytes)`);
      const { res } = await importFile("[smoke] import docx bomb", "bomb.docx", DOCX, bytes);
      assert(res.status === 400, `status ${res.status}`);
      const msg = (await res.json()).message ?? "";
      assert(/expands to far more|took too long/.test(msg), `message: ${msg}`);
      const ready = await fetchWithCookies("/api/v1/readyz");
      assert(ready.res.status === 200, `the API stopped answering (${ready.res.status})`);
      assert((await pageCount()) === before, "a page was left behind");
    });

    await test("wiki import: a .pdf that inflates to a GiB is refused, the API keeps serving and no page is left", async () => {
      const before = await pageCount();
      const content = await deflateRepeated(false, Buffer.from("BT /F1 12 Tf 72 700 Td (hello) Tj ET\n"), Buffer.from("q Q ".repeat(256 * 1024)), GIB_MB);
      const bytes = pdfWith(content.data);
      assert(bytes.length < 5 * 1024 * 1024, `the bomb should be small (${bytes.length} bytes)`);
      const { res } = await importFile("[smoke] import pdf bomb", "bomb.pdf", "application/pdf", bytes);
      assert(res.status === 400, `status ${res.status}`);
      assert(/expands to far more|took too long/.test((await res.json()).message ?? ""), "message should explain the refusal");
      const ready = await fetchWithCookies("/api/v1/readyz");
      assert(ready.res.status === 200, `the API stopped answering (${ready.res.status})`);
      assert((await pageCount()) === before, "a page was left behind");
    });
  } finally {
    // By title as well as by id: a page a failing test never got to record (a refused file that was accepted) must not stay.
    const all = await session("/api/v1/wiki").then(({ res }) => res.json()).catch(() => []);
    const strays = Array.isArray(all) ? all.filter((p) => String(p.title).startsWith("[smoke] import")).map((p) => p.id) : [];
    for (const id of new Set([...made, ...strays])) await session(`/api/v1/wiki/${id}`, { method: "DELETE" }).catch(() => undefined);
  }
}
