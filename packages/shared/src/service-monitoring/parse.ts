/**
 * Output parsers for service templates (a closed list, docs/service-monitoring.md section 3). Every parser turns what a
 * collector got back into ROWS (an array of records), so metrics, members and filters work the same whatever the
 * service speaks. Pure; the fixture tests in apps/api/test/service-monitoring.test.ts run them on captured output.
 */

export type Row = Record<string, unknown>;

export type ParserSpec =
  | { type: "json"; rows?: string; columns?: string }
  | { type: "csv"; delimiter?: string; header?: boolean }
  | { type: "prometheus" }
  | { type: "kv"; separator?: string }
  | { type: "regex"; pattern: string }
  | { type: "lines" }
  | { type: "text" };

export const PARSER_TYPES = ["json", "csv", "prometheus", "kv", "regex", "lines", "text"] as const;

const MAX_ROWS = 20_000;
const MAX_REGEX_INPUT = 256 * 1024;

export class ParseError extends Error {}

/**
 * A path into parsed JSON: `a.b`, `a[0]`, `a["key with dots"]`, `a.*` (every value of an object, each row gets `_key`)
 * and `a[*]` (every item of a list). An empty path is the whole value.
 */
export function jsonPath(value: unknown, path: string): unknown[] {
  let cur: Array<{ v: unknown; key?: string }> = [{ v: value }];
  const parts = splitPath(path);
  for (const part of parts) {
    const next: Array<{ v: unknown; key?: string }> = [];
    for (const { v } of cur) {
      if (part === "*") {
        if (Array.isArray(v)) v.forEach((x, i) => next.push({ v: x, key: String(i) }));
        else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) next.push({ v: x, key: k });
      } else if (Array.isArray(v) && /^\d+$/.test(part)) {
        if (Number(part) < v.length) next.push({ v: v[Number(part)] });
      } else if (v && typeof v === "object" && !Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, part)) {
        next.push({ v: (v as Record<string, unknown>)[part] });
      }
    }
    cur = next;
  }
  return cur.map(({ v, key }) => (key !== undefined && v && typeof v === "object" && !Array.isArray(v) ? { _key: key, ...(v as Row) } : key !== undefined ? { _key: key, value: v } : v));
}

export function splitPath(path: string): string[] {
  const out: string[] = [];
  const p = path.trim().replace(/^\$\.?/, "");
  let i = 0;
  let cur = "";
  while (i < p.length) {
    const c = p[i]!;
    if (c === ".") {
      if (cur) out.push(cur);
      cur = "";
      i++;
    } else if (c === "[") {
      if (cur) out.push(cur);
      cur = "";
      const end = p.indexOf("]", i);
      if (end < 0) throw new ParseError(`"[" without "]" in the path "${path}"`);
      let inner = p.slice(i + 1, end).trim();
      if ((inner.startsWith('"') && inner.endsWith('"')) || (inner.startsWith("'") && inner.endsWith("'"))) inner = inner.slice(1, -1);
      out.push(inner);
      i = end + 1;
    } else {
      cur += c;
      i++;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** One field of a row by path (`scur`, `value[0][0]`, `arguments.pkt4-received`). Whole-key match first. */
export function rowField(row: Row, path: string): unknown {
  if (Object.prototype.hasOwnProperty.call(row, path)) return row[path];
  const found = jsonPath(row, path);
  return found.length ? found[0] : undefined;
}

function parseCsvLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"' && cur === "") q = true;
    else if (c === delim) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function csvRows(text: string, delim: string, header: boolean): Row[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (!lines.length) return [];
  if (!header) return lines.slice(0, MAX_ROWS).map((l) => Object.fromEntries(parseCsvLine(l, delim).map((v, i) => [`c${i + 1}`, v])));
  // HAProxy writes its header as a comment ("# pxname,svname,...").
  const cols = parseCsvLine(lines[0]!.replace(/^#\s*/, ""), delim).map((c) => c.trim());
  return lines.slice(1, MAX_ROWS + 1).filter((l) => !l.startsWith("#")).map((l) => {
    const vals = parseCsvLine(l, delim);
    const row: Row = {};
    cols.forEach((c, i) => {
      if (c) row[c] = vals[i] ?? "";
    });
    return row;
  });
}

const PROM_LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(.*)\})?\s+(\S+)(?:\s+\S+)?\s*$/;

function promLabels(s: string): Row {
  const out: Row = {};
  const re = /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"\s*,?/g;
  for (const m of s.matchAll(re)) out[m[1]!] = m[2]!.replace(/\\n/g, "\n").replace(/\\(.)/g, "$1");
  return out;
}

function promValue(s: string): number | null {
  if (s === "NaN") return null;
  if (s === "+Inf" || s === "Inf") return Infinity;
  if (s === "-Inf") return -Infinity;
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
}

/** Prometheus text format: one row per sample, `{__name__, ...labels, value}`. Comments and HELP/TYPE are skipped. */
export function prometheusRows(text: string): Row[] {
  const out: Row[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = PROM_LINE.exec(line);
    if (!m) continue;
    // `_labels` keeps the raw label text, so a filter can match on it without knowing the label names.
    out.push({ __name__: m[1]!, ...(m[3] ? promLabels(m[3]) : {}), _labels: m[3] ?? "", value: promValue(m[4]!) });
    if (out.length >= MAX_ROWS * 5) break;
  }
  return out;
}

function kvRow(text: string, sep: string | undefined): Row {
  const row: Row = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let i = -1;
    let len = 1;
    if (sep) {
      i = line.indexOf(sep);
      len = sep.length;
    } else {
      const m = /[:=]/.exec(line);
      i = m ? m.index : -1;
    }
    if (i <= 0) continue;
    row[line.slice(0, i).trim()] = line.slice(i + len).trim();
  }
  return row;
}

function regexRows(text: string, pattern: string): Row[] {
  let re: RegExp;
  try {
    re = new RegExp(pattern, "gm");
  } catch (e) {
    throw new ParseError(`the pattern does not read: ${(e as Error).message}`);
  }
  const out: Row[] = [];
  for (const m of text.slice(0, MAX_REGEX_INPUT).matchAll(re)) {
    if (m[0] === "") break;
    const row: Row = { match: m[0] };
    m.slice(1).forEach((g, i) => (row[`g${i + 1}`] = g ?? null));
    for (const [k, v] of Object.entries(m.groups ?? {})) row[k] = v ?? null;
    out.push(row);
    if (out.length >= MAX_ROWS) break;
  }
  return out;
}

function lineRows(text: string): Row[] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .slice(0, MAX_ROWS)
    .map((line, i) => {
      const row: Row = { n: i + 1, line: line.trim() };
      line.trim().split(/\s+/).forEach((f, j) => (row[`f${j + 1}`] = f));
      return row;
    });
}

/** Text -> rows with the template's parser. Throws ParseError with a reason when the text is not what it said. */
export function parseOutput(text: string, spec: ParserSpec): Row[] {
  switch (spec.type) {
    case "json": {
      let v: unknown;
      try {
        v = JSON.parse(text);
      } catch {
        throw new ParseError("the answer is not JSON");
      }
      if (spec.columns) {
        const cols = jsonPath(v, spec.columns)[0];
        const rows = jsonPath(v, spec.rows ?? "")[0];
        if (!Array.isArray(cols) || !Array.isArray(rows)) throw new ParseError(`"${spec.columns}" or "${spec.rows ?? ""}" is not a list`);
        return rows.slice(0, MAX_ROWS).map((r) => Object.fromEntries(cols.map((c, i) => [String(c), Array.isArray(r) ? r[i] : undefined])));
      }
      const found = jsonPath(v, spec.rows ?? "");
      const flat = found.length === 1 && Array.isArray(found[0]) ? (found[0] as unknown[]) : found;
      return flat.slice(0, MAX_ROWS).map((x) => (x && typeof x === "object" && !Array.isArray(x) ? (x as Row) : { value: x }));
    }
    case "csv":
      return csvRows(text, spec.delimiter ?? ",", spec.header !== false);
    case "prometheus":
      return prometheusRows(text);
    case "kv":
      return [kvRow(text, spec.separator)];
    case "regex":
      return regexRows(text, spec.pattern);
    case "lines":
      return lineRows(text);
    case "text":
      return [{ text: text.trim() }];
    default:
      return [];
  }
}
