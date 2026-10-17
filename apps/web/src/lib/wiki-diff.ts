import { diffLines, diffWordsWithSpace } from "diff";

/** One run of text inside a changed line; `changed` marks the words that differ from the other side. */
export interface DiffSegment {
  text: string;
  changed: boolean;
}

export type DiffRow =
  | { kind: "same"; text: string; oldNo: number; newNo: number }
  | { kind: "add"; text: string; oldNo: null; newNo: number; segments: DiffSegment[] }
  | { kind: "remove"; text: string; oldNo: number; newNo: null; segments: DiffSegment[] };

export interface DiffResult {
  rows: DiffRow[];
  added: number;
  removed: number;
}

/** Lines of a block of text, without the empty tail a trailing newline leaves. */
function linesOf(value: string): string[] {
  const lines = value.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Words that differ between two lines, for the highlight inside a changed line. */
function wordSegments(from: string, to: string): { from: DiffSegment[]; to: DiffSegment[] } {
  const out = { from: [] as DiffSegment[], to: [] as DiffSegment[] };
  for (const part of diffWordsWithSpace(from, to)) {
    if (part.added) out.to.push({ text: part.value, changed: true });
    else if (part.removed) out.from.push({ text: part.value, changed: true });
    else {
      out.from.push({ text: part.value, changed: false });
      out.to.push({ text: part.value, changed: false });
    }
  }
  return out;
}

/**
 * Line by line difference between two versions of a page. A removed block directly followed by an added block is treated
 * as an edit: lines are paired in order and the words that changed inside each pair are marked, so a fixed typo shows as
 * one word rather than two whole lines. Unpaired lines are plain additions or removals.
 */
export function buildDiff(fromText: string, toText: string): DiffResult {
  // A last line with no newline would otherwise differ from the same line followed by one.
  const endWithNewline = (t: string) => (t === "" || t.endsWith("\n") ? t : `${t}\n`);
  const from = endWithNewline(fromText);
  const to = endWithNewline(toText);
  const rows: DiffRow[] = [];
  let added = 0;
  let removed = 0;
  let oldNo = 1;
  let newNo = 1;
  const parts = diffLines(from, to);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (!part.added && !part.removed) {
      for (const text of linesOf(part.value)) rows.push({ kind: "same", text, oldNo: oldNo++, newNo: newNo++ });
      continue;
    }
    const next = parts[i + 1];
    if (part.removed && next?.added) {
      const gone = linesOf(part.value);
      const came = linesOf(next.value);
      const paired = Math.min(gone.length, came.length);
      const segs = Array.from({ length: paired }, (_, k) => wordSegments(gone[k]!, came[k]!));
      gone.forEach((text, k) => {
        rows.push({ kind: "remove", text, oldNo: oldNo++, newNo: null, segments: k < paired ? segs[k]!.from : [{ text, changed: true }] });
        removed++;
      });
      came.forEach((text, k) => {
        rows.push({ kind: "add", text, oldNo: null, newNo: newNo++, segments: k < paired ? segs[k]!.to : [{ text, changed: true }] });
        added++;
      });
      i++;
      continue;
    }
    for (const text of linesOf(part.value)) {
      if (part.added) {
        rows.push({ kind: "add", text, oldNo: null, newNo: newNo++, segments: [{ text, changed: true }] });
        added++;
      } else {
        rows.push({ kind: "remove", text, oldNo: oldNo++, newNo: null, segments: [{ text, changed: true }] });
        removed++;
      }
    }
  }
  return { rows, added, removed };
}

export type DiffItem = { type: "row"; row: DiffRow } | { type: "gap"; id: number; rows: DiffRow[] };

/**
 * Fold long stretches of unchanged lines into a gap that shows how many were left out, keeping `context` lines around each
 * change. A gap of one or two lines is not worth hiding, so it stays.
 */
export function collapseUnchanged(rows: DiffRow[], context = 3): DiffItem[] {
  const keep = new Array<boolean>(rows.length).fill(false);
  rows.forEach((r, i) => {
    if (r.kind === "same") return;
    for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) keep[k] = true;
  });
  const items: DiffItem[] = [];
  let gapId = 0;
  let i = 0;
  while (i < rows.length) {
    if (keep[i] || rows.length === 0) {
      items.push({ type: "row", row: rows[i]! });
      i++;
      continue;
    }
    let j = i;
    while (j < rows.length && !keep[j]) j++;
    const run = rows.slice(i, j);
    if (run.length <= 2) run.forEach((row) => items.push({ type: "row", row }));
    else items.push({ type: "gap", id: gapId++, rows: run });
    i = j;
  }
  return items;
}
