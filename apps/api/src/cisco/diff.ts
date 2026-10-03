import type { CiscoBackupDiffLine } from "@church/shared";

const CONTEXT = 10;
const MAX_LCS_LINES = 3000; // guard the O(n*m) table; fall back beyond this

export interface DiffResult {
  diff: CiscoBackupDiffLine[];
  added: number;
  removed: number;
}

/**
 * Line-oriented diff of two config snapshots (A = older, B = newer), returning
 * the change-runs with `CONTEXT` lines of surrounding context and `separator`
 * markers for collapsed unchanged regions. Ported from the cisco-switch diff
 * endpoint (LCS with a large-file fallback).
 */
export function diffConfigs(aText: string, bText: string): DiffResult {
  const a = aText.split("\n");
  const b = bText.split("\n");

  const ops = a.length > MAX_LCS_LINES || b.length > MAX_LCS_LINES ? naiveOps(a, b) : lcsOps(a, b);

  let added = 0;
  let removed = 0;
  for (const o of ops) {
    if (o.type === "added") added++;
    else if (o.type === "removed") removed++;
  }

  // Collapse long unchanged runs to a single separator, keeping CONTEXT lines
  // on each side of any change.
  const keep = new Array<boolean>(ops.length).fill(false);
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]!.type !== "context") {
      for (let j = Math.max(0, i - CONTEXT); j <= Math.min(ops.length - 1, i + CONTEXT); j++) {
        keep[j] = true;
      }
    }
  }
  const diff: CiscoBackupDiffLine[] = [];
  let omitting = false;
  for (let i = 0; i < ops.length; i++) {
    if (keep[i]) {
      omitting = false;
      diff.push(ops[i]!);
    } else if (!omitting) {
      omitting = true;
      diff.push({ type: "separator", line: "⋯ lines omitted ⋯" });
    }
  }
  return { diff, added, removed };
}

type Op = CiscoBackupDiffLine;

function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i..], b[j..]
  const dp: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "context", line: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ type: "removed", line: a[i]! });
      i++;
    } else {
      ops.push({ type: "added", line: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ type: "removed", line: a[i++]! });
  while (j < m) ops.push({ type: "added", line: b[j++]! });
  return ops;
}

/** Cheap fallback for very large configs: set-membership line diff. */
function naiveOps(a: string[], b: string[]): Op[] {
  const bSet = new Set(b);
  const aSet = new Set(a);
  const ops: Op[] = [];
  for (const line of a) ops.push({ type: bSet.has(line) ? "context" : "removed", line });
  for (const line of b) if (!aSet.has(line)) ops.push({ type: "added", line });
  return ops;
}
