import { createHash } from "node:crypto";
import type { SearchDoc } from "./search-types";

/** JSON with object keys sorted, so equal documents always serialise the same. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

/**
 * Hash of what a document says. `updatedAt` is left out: some sources (the Cisco
 * caches, UniFi) have no real modification time and stamp "now" each time they
 * are built, which would make every document look changed on every pass. For
 * content kinds a real edit changes the title or body anyway.
 */
export function docRev(doc: SearchDoc): string {
  const { updatedAt: _updatedAt, rev: _rev, ...rest } = doc;
  return createHash("sha1").update(canonical(rest)).digest("hex").slice(0, 16);
}

/** The document with its `rev` stamped. */
export function withRev(doc: SearchDoc): SearchDoc {
  return { ...doc, rev: docRev(doc) };
}

/**
 * What it takes to make an index that holds `existing` (id -> rev, or undefined
 * for a document indexed before revs existed) match `desired`: the documents to
 * write and the ids to delete.
 */
export function diffDocs(
  existing: Map<string, string | undefined>,
  desired: SearchDoc[],
): { upserts: SearchDoc[]; deletes: string[] } {
  const want = new Map<string, SearchDoc>();
  for (const d of desired) want.set(d.id, withRev(d));
  const upserts: SearchDoc[] = [];
  for (const [id, doc] of want) if (existing.get(id) !== doc.rev) upserts.push(doc);
  const deletes: string[] = [];
  for (const id of existing.keys()) if (!want.has(id)) deletes.push(id);
  return { upserts, deletes };
}
