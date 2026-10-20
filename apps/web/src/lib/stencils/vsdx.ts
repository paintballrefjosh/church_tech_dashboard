/**
 * Pictures out of a Visio package (.vsdx drawing, .vssx stencil): a zip of XML parts. `masters.xml` lists the masters
 * with their names and prompt text; each master's own part has a ForeignData element pointing, through the part's
 * relationships, at a picture under visio/media (an EMF for vendor art). Media no master points at is listed too,
 * unnamed, so a drawing's pictures are not lost.
 */
import type { ZipEntry } from "./zip";
import { sniffPicture } from "./sniff";
import type { ReadResult, StencilPicture } from "./types";

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (let m = re.exec(tag); m; m = re.exec(tag)) out[m[1]!] = unescapeXml(m[2] ?? m[3] ?? "");
  return out;
}

function unescapeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Where `target` points, from a part in `fromDir` ("visio/masters/" + "../media/image1.emf" = "visio/media/image1.emf"). */
function resolvePath(fromDir: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = (fromDir + target).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p !== "." && p !== "") out.push(p);
  }
  return out.join("/");
}

function relationships(xml: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of xml.matchAll(/<Relationship\b[^>]*>/g)) {
    const a = attrs(m[0]);
    if (a.Id && a.Target) map.set(a.Id, a.Target);
  }
  return map;
}

export async function readVisioPackage(entries: ZipEntry[], sourceName: string): Promise<ReadResult> {
  const byName = new Map(entries.map((e) => [e.name, e]));
  const text = async (name: string): Promise<string | null> => {
    const e = byName.get(name);
    return e ? new TextDecoder("utf-8").decode(await e.read()) : null;
  };
  const pictures: StencilPicture[] = [];
  const notes: string[] = [];
  const used = new Set<string>();
  let n = 0;

  const mastersXml = await text("visio/masters/masters.xml");
  const mastersRels = relationships((await text("visio/masters/_rels/masters.xml.rels")) ?? "");
  if (mastersXml) {
    let masterNo = 0;
    for (const m of mastersXml.matchAll(/<Master\b[^>]*?(?:\/>|>[\s\S]*?<\/Master>)/g)) {
      masterNo++;
      const open = /^<Master\b[^>]*>/.exec(m[0])?.[0] ?? "";
      const a = attrs(open);
      const relId = attrs(/<Rel\b[^>]*>/.exec(m[0])?.[0] ?? "")["r:id"];
      const partTarget = relId ? mastersRels.get(relId) : undefined;
      if (!partTarget) continue;
      const partPath = resolvePath("visio/masters/", partTarget);
      const partXml = await text(partPath);
      if (!partXml) continue;
      const dir = partPath.slice(0, partPath.lastIndexOf("/") + 1);
      const rels = relationships((await text(`${dir}_rels/${partPath.slice(partPath.lastIndexOf("/") + 1)}.rels`)) ?? "");
      for (const fd of partXml.matchAll(/<ForeignData\b[^>]*>[\s\S]*?<\/ForeignData>/g)) {
        const rid = attrs(/<Rel\b[^>]*>/.exec(fd[0])?.[0] ?? "")["r:id"];
        const target = rid ? rels.get(rid) : undefined;
        if (!target) continue;
        const mediaPath = resolvePath(dir, target);
        const e = byName.get(mediaPath);
        if (!e) continue;
        try {
          const bytes = await e.read();
          const kind = sniffPicture(bytes);
          if (!kind) continue;
          used.add(mediaPath);
          n++;
          const name = a.Name || a.NameU || null;
          pictures.push({
            id: `${sourceName}#${n}`,
            kind,
            bytes,
            name,
            description: a.Prompt && a.Prompt !== name ? a.Prompt : null,
            source: `${sourceName}, master ${masterNo}`,
          });
        } catch (err) {
          notes.push(`${mediaPath} could not be read: ${(err as Error).message}`);
        }
      }
    }
  }

  // media nothing above pointed at (a drawing's own pictures)
  for (const e of entries) {
    if (!/^visio\/media\//i.test(e.name) || used.has(e.name)) continue;
    try {
      const bytes = await e.read();
      const kind = sniffPicture(bytes);
      if (!kind) continue;
      n++;
      pictures.push({ id: `${sourceName}#${n}`, kind, bytes, name: null, description: null, source: `${sourceName}, ${e.name}` });
    } catch (err) {
      notes.push(`${e.name} could not be read: ${(err as Error).message}`);
    }
  }
  if (pictures.length === 0) notes.push(`No pictures were found in ${sourceName}. It may hold only drawn shapes, which cannot be turned into a picture here.`);
  return { pictures, notes };
}
