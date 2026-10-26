/**
 * The expression language of service templates (docs/service-monitoring.md section 3): `where` filters, derived metrics
 * and check conditions. It is deliberately small and closed: literals, names, arithmetic, comparisons, `&&` `||` `!`,
 * the `? :` choice and a fixed list of functions. There are no loops, no assignment, no property access on values, no
 * user functions and nothing that reaches outside the values it is given, so a template written in the GUI cannot run
 * code. Expressions are parsed once (`parseExpr`, which reports a problem in words) and evaluated many times.
 *
 * Names: letters, digits, `_` and `.` (`backend_down`, `pg.connections`); a name with other characters is written in
 * backticks (`` `hrsp_5xx` `` needs none, `` `wsrep-cluster-size` `` does). An unknown name is `null`. Arithmetic with
 * `null` gives `null`, and every comparison with `null` is false except `== null` / `!= null`, so a missing reading never
 * fires a check on its own.
 */

export type ExprValue = number | string | boolean | null;

export type ExprNode =
  | { t: "lit"; v: ExprValue }
  | { t: "name"; n: string }
  | { t: "un"; op: "!" | "-"; a: ExprNode }
  | { t: "bin"; op: BinOp; a: ExprNode; b: ExprNode }
  | { t: "if"; c: ExprNode; a: ExprNode; b: ExprNode }
  | { t: "call"; f: FnName; args: ExprNode[] };

type BinOp = "||" | "&&" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "+" | "-" | "*" | "/" | "%";

export const EXPR_FUNCTIONS = {
  abs: [1, 1],
  min: [1, 20],
  max: [1, 20],
  round: [1, 2],
  floor: [1, 1],
  ceil: [1, 1],
  coalesce: [1, 20],
  num: [1, 1],
  str: [1, 1],
  lower: [1, 1],
  upper: [1, 1],
  len: [1, 1],
  contains: [2, 2],
  startsWith: [2, 2],
  endsWith: [2, 2],
} as const satisfies Record<string, readonly [number, number]>;
export type FnName = keyof typeof EXPR_FUNCTIONS;

export const EXPR_MAX_LENGTH = 1000;
const MAX_DEPTH = 40;

export class ExprError extends Error {}

type Tok =
  | { k: "num"; v: number; at: number }
  | { k: "str"; v: string; at: number }
  | { k: "name"; v: string; at: number }
  | { k: "op"; v: string; at: number }
  | { k: "end"; at: number };

const OPS = ["||", "&&", "==", "!=", "<=", ">=", "<", ">", "+", "-", "*", "/", "%", "!", "(", ")", ",", "?", ":"];

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i))!;
      out.push({ k: "num", v: Number(m[0]), at: i });
      i += m[0].length;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\" && j + 1 < src.length) {
          const n = src[j + 1]!;
          s += n === "n" ? "\n" : n === "t" ? "\t" : n;
          j += 2;
        } else s += src[j++];
      }
      if (j >= src.length) throw new ExprError(`a text in quotes is not closed (at ${i + 1})`);
      out.push({ k: "str", v: s, at: i });
      i = j + 1;
      continue;
    }
    if (c === "`") {
      const j = src.indexOf("`", i + 1);
      if (j < 0) throw new ExprError(`a name in backticks is not closed (at ${i + 1})`);
      const name = src.slice(i + 1, j);
      if (!name) throw new ExprError(`an empty name in backticks (at ${i + 1})`);
      out.push({ k: "name", v: name, at: i });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i))!;
      out.push({ k: "name", v: m[0], at: i });
      i += m[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExprError(`unexpected "${c}" (at ${i + 1})`);
    out.push({ k: "op", v: op, at: i });
    i += op.length;
  }
  out.push({ k: "end", at: src.length });
  return out;
}

/** Parses an expression or throws ExprError with a reason a person can act on. */
export function parseExpr(src: string): ExprNode {
  if (typeof src !== "string" || !src.trim()) throw new ExprError("the expression is empty");
  if (src.length > EXPR_MAX_LENGTH) throw new ExprError(`the expression is longer than ${EXPR_MAX_LENGTH} characters`);
  const toks = tokenize(src);
  let p = 0;
  let depth = 0;
  const peek = () => toks[p]!;
  const isOp = (v: string) => {
    const t = peek();
    return t.k === "op" && t.v === v;
  };
  const expect = (v: string) => {
    if (!isOp(v)) throw new ExprError(`expected "${v}" (at ${peek().at + 1})`);
    p++;
  };
  const deeper = <T>(f: () => T): T => {
    if (++depth > MAX_DEPTH) throw new ExprError("the expression is nested too deeply");
    try {
      return f();
    } finally {
      depth--;
    }
  };

  const ternary = (): ExprNode =>
    deeper(() => {
      const c = binary(0);
      if (!isOp("?")) return c;
      p++;
      const a = ternary();
      expect(":");
      const b = ternary();
      return { t: "if", c, a, b };
    });

  const LEVELS: string[][] = [["||"], ["&&"], ["==", "!="], ["<", "<=", ">", ">="], ["+", "-"], ["*", "/", "%"]];
  const binary = (level: number): ExprNode =>
    deeper(() => {
      if (level >= LEVELS.length) return unary();
      let a = binary(level + 1);
      for (;;) {
        const t = peek();
        if (t.k !== "op" || !LEVELS[level]!.includes(t.v)) return a;
        p++;
        const b = binary(level + 1);
        a = { t: "bin", op: t.v as BinOp, a, b };
      }
    });

  const unary = (): ExprNode =>
    deeper(() => {
      if (isOp("!") || isOp("-")) {
        const op = (peek() as { v: "!" | "-" }).v;
        p++;
        return { t: "un", op, a: unary() };
      }
      return primary();
    });

  const primary = (): ExprNode => {
    const t = peek();
    if (t.k === "num") {
      p++;
      return { t: "lit", v: t.v };
    }
    if (t.k === "str") {
      p++;
      return { t: "lit", v: t.v };
    }
    if (t.k === "name") {
      p++;
      if (t.v === "true" || t.v === "false") return { t: "lit", v: t.v === "true" };
      if (t.v === "null") return { t: "lit", v: null };
      if (isOp("(")) {
        if (!(t.v in EXPR_FUNCTIONS)) throw new ExprError(`unknown function "${t.v}" (known: ${Object.keys(EXPR_FUNCTIONS).join(", ")})`);
        const f = t.v as FnName;
        p++;
        const args: ExprNode[] = [];
        if (!isOp(")")) {
          for (;;) {
            args.push(ternary());
            if (isOp(",")) {
              p++;
              continue;
            }
            break;
          }
        }
        expect(")");
        const [lo, hi] = EXPR_FUNCTIONS[f];
        if (args.length < lo || args.length > hi) throw new ExprError(`${f}() takes ${lo === hi ? lo : `${lo} to ${hi}`} argument${hi === 1 ? "" : "s"}`);
        return { t: "call", f, args };
      }
      return { t: "name", n: t.v };
    }
    if (t.k === "op" && t.v === "(") {
      p++;
      const e = ternary();
      expect(")");
      return e;
    }
    throw new ExprError(t.k === "end" ? "the expression ends too early" : `unexpected "${t.v}" (at ${t.at + 1})`);
  };

  const e = ternary();
  if (peek().k !== "end") throw new ExprError(`unexpected "${(peek() as { v?: string }).v ?? ""}" (at ${peek().at + 1})`);
  return e;
}

/** Every name an expression reads (for checking a template refers only to things that exist). */
export function exprNames(node: ExprNode, into: Set<string> = new Set()): Set<string> {
  switch (node.t) {
    case "name":
      into.add(node.n);
      break;
    case "un":
      exprNames(node.a, into);
      break;
    case "bin":
      exprNames(node.a, into);
      exprNames(node.b, into);
      break;
    case "if":
      exprNames(node.c, into);
      exprNames(node.a, into);
      exprNames(node.b, into);
      break;
    case "call":
      node.args.forEach((a) => exprNames(a, into));
      break;
    default:
      break;
  }
  return into;
}

const toNum = (v: ExprValue): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const truthy = (v: ExprValue): boolean => v !== null && v !== false && v !== 0 && v !== "";

function equal(a: ExprValue, b: ExprValue): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a === "number" || typeof b === "number") {
    const x = toNum(a);
    const y = toNum(b);
    return x !== null && y !== null && x === y;
  }
  return String(a) === String(b);
}

/** Evaluates a parsed expression against named values. Never throws: anything undefined becomes null. */
export function evalExpr(node: ExprNode, lookup: (name: string) => ExprValue): ExprValue {
  switch (node.t) {
    case "lit":
      return node.v;
    case "name":
      return lookup(node.n);
    case "un": {
      const a = evalExpr(node.a, lookup);
      if (node.op === "!") return !truthy(a);
      const n = toNum(a);
      return n === null ? null : -n;
    }
    case "if":
      return truthy(evalExpr(node.c, lookup)) ? evalExpr(node.a, lookup) : evalExpr(node.b, lookup);
    case "bin": {
      if (node.op === "||") return truthy(evalExpr(node.a, lookup)) || truthy(evalExpr(node.b, lookup));
      if (node.op === "&&") return truthy(evalExpr(node.a, lookup)) && truthy(evalExpr(node.b, lookup));
      const a = evalExpr(node.a, lookup);
      const b = evalExpr(node.b, lookup);
      if (node.op === "==") return equal(a, b);
      if (node.op === "!=") return !equal(a, b);
      if (node.op === "+" && (typeof a === "string" || typeof b === "string") && toNum(a) === null) {
        return a === null || b === null ? null : `${a}${b}`;
      }
      if (["<", "<=", ">", ">="].includes(node.op)) {
        if (a === null || b === null) return false;
        const x = toNum(a);
        const y = toNum(b);
        const [l, r]: [number | string, number | string] = x !== null && y !== null ? [x, y] : [String(a), String(b)];
        return node.op === "<" ? l < r : node.op === "<=" ? l <= r : node.op === ">" ? l > r : l >= r;
      }
      const x = toNum(a);
      const y = toNum(b);
      if (x === null || y === null) return null;
      switch (node.op) {
        case "+":
          return x + y;
        case "-":
          return x - y;
        case "*":
          return x * y;
        case "/":
          return y === 0 ? null : x / y;
        case "%":
          return y === 0 ? null : x % y;
        default:
          return null;
      }
    }
    case "call": {
      const args = node.args.map((a) => evalExpr(a, lookup));
      const nums = () => args.map(toNum).filter((n): n is number => n !== null);
      const s = (v: ExprValue) => (v === null ? null : String(v));
      switch (node.f) {
        case "abs": {
          const n = toNum(args[0]!);
          return n === null ? null : Math.abs(n);
        }
        case "min":
          return nums().length ? Math.min(...nums()) : null;
        case "max":
          return nums().length ? Math.max(...nums()) : null;
        case "round": {
          const n = toNum(args[0]!);
          const d = Math.max(0, Math.min(10, toNum(args[1] ?? 0) ?? 0));
          return n === null ? null : Math.round(n * 10 ** d) / 10 ** d;
        }
        case "floor": {
          const n = toNum(args[0]!);
          return n === null ? null : Math.floor(n);
        }
        case "ceil": {
          const n = toNum(args[0]!);
          return n === null ? null : Math.ceil(n);
        }
        case "coalesce":
          return args.find((a) => a !== null) ?? null;
        case "num":
          return toNum(args[0]!);
        case "str":
          return s(args[0]!);
        case "lower":
          return s(args[0]!)?.toLowerCase() ?? null;
        case "upper":
          return s(args[0]!)?.toUpperCase() ?? null;
        case "len":
          return args[0] === null ? null : String(args[0]).length;
        case "contains":
          return args[0] === null || args[1] === null ? false : String(args[0]).includes(String(args[1]));
        case "startsWith":
          return args[0] === null || args[1] === null ? false : String(args[0]).startsWith(String(args[1]));
        case "endsWith":
          return args[0] === null || args[1] === null ? false : String(args[0]).endsWith(String(args[1]));
        default:
          return null;
      }
    }
    default:
      return null;
  }
}

export const exprTruthy = truthy;
export const exprNumber = toNum;
