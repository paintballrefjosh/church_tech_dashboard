import { evalExpr, exprNumber, exprTruthy, parseExpr, type ExprNode, type ExprValue } from "./expr";
import { rowField, type Row } from "./parse";
import type { ServiceTemplateBody } from "./template";

/**
 * The template engine's pure half: given what each collector returned, compute the metrics, the members and the checks.
 * The API's poller (apps/api/src/service-monitoring/) does the network side, storage, incidents and notices. Counters
 * become rates here (the template never does the maths), from the previous reading the caller keeps between polls.
 */

export interface CollectorOutcome {
  rows: Row[] | null; // null = it failed
  error: string | null;
}

export interface CounterReading {
  v: number;
  t: number; // epoch ms
}

export interface ServiceMember {
  key: string;
  name: string;
  ok: boolean | null;
  columns: Record<string, ExprValue>;
}

export interface ServiceCheckResult {
  id: string;
  severity: "warning" | "critical";
  breaching: boolean;
  /** The check's text with its values filled in. */
  text: string;
}

export interface EngineResult {
  values: Record<string, number | null>;
  states: Record<string, string | null>;
  members: ServiceMember[];
  membersOmitted: number;
  checks: ServiceCheckResult[];
  counters: Record<string, CounterReading>;
  /** Collectors that failed, with their reason. */
  errors: Record<string, string>;
  /** A collector that is not `optional` failed: the instance is down and its checks are not judged. */
  down: boolean;
}

const cache = new Map<string, ExprNode>();
function compiled(src: string): ExprNode {
  let n = cache.get(src);
  if (!n) {
    n = parseExpr(src);
    if (cache.size > 5000) cache.clear();
    cache.set(src, n);
  }
  return n;
}

function scalar(v: unknown): ExprValue {
  if (v === undefined || v === null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" || typeof v === "boolean") return v;
  return null;
}

function rowLookup(row: Row, inputs: Record<string, ExprValue>) {
  return (name: string): ExprValue => (name.startsWith("inputs.") ? inputs[name.slice(7)] ?? null : scalar(rowField(row, name)));
}

/** A number written for a person: at most 2 decimals, no trailing zeros. */
export function formatServiceValue(v: ExprValue | undefined): string {
  if (v === null || v === undefined) return "?";
  if (typeof v === "number") return String(Math.round(v * 100) / 100);
  return String(v);
}

/** Fills `{{metric}}` in a check's text. */
export function fillText(text: string, lookup: (name: string) => ExprValue): string {
  return text.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g, (_, k: string) => formatServiceValue(lookup(k)));
}

export function evaluateService(
  body: ServiceTemplateBody,
  outcomes: Record<string, CollectorOutcome>,
  inputs: Record<string, ExprValue>,
  prevCounters: Record<string, CounterReading>,
  nowMs: number,
): EngineResult {
  const errors: Record<string, string> = {};
  let down = false;
  for (const [name, c] of Object.entries(body.collect)) {
    const o = outcomes[name];
    if (!o || o.rows === null) {
      errors[name] = o?.error ?? "not collected";
      if (!c.optional) down = true;
    }
  }
  const rowsOf = (name: string): Row[] | null => outcomes[name]?.rows ?? null;

  // Members first: metrics and checks may count them.
  const members: ServiceMember[] = [];
  let membersOmitted = 0;
  if (body.members) {
    const m = body.members;
    const rows = rowsOf(m.from) ?? [];
    const where = m.where ? compiled(m.where) : null;
    const okExpr = m.ok ? compiled(m.ok) : null;
    const limit = m.limit ?? 100;
    for (const row of rows) {
      const look = rowLookup(row, inputs);
      if (where && !exprTruthy(evalExpr(where, look))) continue;
      const key = formatServiceValue(scalar(rowField(row, m.key)));
      const ok = okExpr ? exprTruthy(evalExpr(okExpr, look)) : null;
      if (members.length >= limit) {
        membersOmitted++;
        continue;
      }
      const columns: Record<string, ExprValue> = {};
      for (const [col, src] of Object.entries(m.columns ?? {})) columns[col] = evalExpr(compiled(src), look);
      members.push({ key, name: m.name ? formatServiceValue(scalar(rowField(row, m.name))) : key, ok, columns });
    }
    // Problems first, so a cut-off list still shows what is wrong.
    members.sort((a, b) => Number(a.ok !== false) - Number(b.ok !== false));
  }

  const values: Record<string, number | null> = {};
  const states: Record<string, string | null> = {};
  const counters: Record<string, CounterReading> = {};
  const metricLookup = (name: string): ExprValue => {
    if (name.startsWith("inputs.")) return inputs[name.slice(7)] ?? null;
    if (name === "members_down") return body.members ? members.filter((x) => x.ok === false).length + 0 : null;
    if (name === "members_total") return body.members ? members.length + membersOmitted : null;
    if (name in values) return values[name]!;
    if (name in states) return states[name]!;
    return null;
  };

  for (const [key, m] of Object.entries(body.metrics)) {
    const kind = m.kind ?? "gauge";
    let v: ExprValue = null;
    if (m.from) {
      const rows = rowsOf(m.from);
      if (rows) {
        const where = m.where ? compiled(m.where) : null;
        const valueExpr = m.value ? compiled(m.value) : null;
        const picked: ExprValue[] = [];
        for (const row of rows) {
          const look = rowLookup(row, inputs);
          if (where && !exprTruthy(evalExpr(where, look))) continue;
          picked.push(valueExpr ? evalExpr(valueExpr, look) : m.field ? scalar(rowField(row, m.field)) : 1);
        }
        const agg = m.agg ?? "first";
        const nums = picked.map(exprNumber).filter((n): n is number => n !== null);
        switch (agg) {
          case "count":
            v = picked.length;
            break;
          case "sum":
            v = nums.length ? nums.reduce((a, b) => a + b, 0) : picked.length === 0 ? 0 : null;
            break;
          case "min":
            v = nums.length ? Math.min(...nums) : null;
            break;
          case "max":
            v = nums.length ? Math.max(...nums) : null;
            break;
          case "avg":
            v = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
            break;
          case "first":
            v = picked[0] ?? null;
            break;
          case "last":
            v = picked[picked.length - 1] ?? null;
            break;
          default:
            v = null;
        }
      }
    } else if (m.expr) {
      v = evalExpr(compiled(m.expr), metricLookup);
    }

    if (kind === "state") {
      states[key] = v === null ? null : formatServiceValue(v);
    } else if (kind === "counter") {
      const n = exprNumber(v);
      const prev = prevCounters[key];
      if (n === null) values[key] = null;
      else {
        counters[key] = { v: n, t: nowMs };
        const dt = prev ? (nowMs - prev.t) / 1000 : 0;
        // A counter that went down was reset (a restart): no rate this time, a fresh baseline.
        values[key] = prev && dt > 0 && n >= prev.v ? (n - prev.v) / dt : null;
      }
    } else {
      const n = exprNumber(v);
      values[key] = n === null || !Number.isFinite(n) ? null : n;
    }
  }

  const checks: ServiceCheckResult[] = body.checks.map((c) => {
    const breaching = !down && exprTruthy(evalExpr(compiled(c.expr), metricLookup));
    return { id: c.id, severity: c.severity, breaching, text: fillText(c.text, metricLookup) };
  });

  return { values, states, members, membersOmitted, checks, counters, errors, down };
}

/** The instance's status from one evaluation: down if a needed collector failed, degraded while a check holds. */
export function serviceStatus(r: Pick<EngineResult, "down" | "checks">, openChecks: ReadonlySet<string>): "up" | "degraded" | "down" {
  if (r.down) return "down";
  return r.checks.some((c) => openChecks.has(c.id)) ? "degraded" : "up";
}

export interface CheckAlertState {
  breachingSince: string | null;
  open: boolean;
  incidentId: string | null;
}

export type CheckTransition = { id: string; action: "open" | "resolve" };

/**
 * One poll's step of every check's alert state (the same rule as infra thresholds): a breach that has held for `for`
 * seconds opens an incident; the first poll it no longer holds resolves it. A down instance's checks are not judged
 * (the collector failing is the problem; a stale reading must not open or close anything).
 */
export function stepCheckAlerts(
  body: ServiceTemplateBody,
  result: Pick<EngineResult, "down" | "checks">,
  prev: Record<string, CheckAlertState>,
  now: Date,
): { state: Record<string, CheckAlertState>; transitions: CheckTransition[] } {
  const state: Record<string, CheckAlertState> = {};
  const transitions: CheckTransition[] = [];
  const known = new Set(body.checks.map((c) => c.id));
  for (const [id, s] of Object.entries(prev)) {
    // A check removed from the template: close what it opened.
    if (!known.has(id)) {
      if (s.open) transitions.push({ id, action: "resolve" });
      continue;
    }
    state[id] = s;
  }
  if (result.down) return { state, transitions };
  for (const c of result.checks) {
    const def = body.checks.find((x) => x.id === c.id)!;
    const s: CheckAlertState = state[c.id] ?? { breachingSince: null, open: false, incidentId: null };
    if (c.breaching) {
      const since = s.breachingSince ?? now.toISOString();
      const held = (now.getTime() - new Date(since).getTime()) / 1000;
      if (!s.open && held >= (def.for ?? 0)) transitions.push({ id: c.id, action: "open" });
      state[c.id] = { ...s, breachingSince: since };
    } else {
      if (s.open) transitions.push({ id: c.id, action: "resolve" });
      state[c.id] = { breachingSince: null, open: false, incidentId: null };
    }
  }
  return { state, transitions };
}
