#!/usr/bin/env node
/**
 * The assistant's live evaluation (docs/assistant.md section 13): asks the CONFIGURED model every question in
 * tests/assistant/questions.yaml as the named accounts and prints a scorecard, so a model or prompt change can be compared
 * before it is rolled out. The expected facts are read at run time from the normal API as the same account (see the YAML).
 *
 * It spends real money, so it asks nothing without --yes. --dry-run reads only the references (free) and prints what each
 * question would expect. Proposal cards are never confirmed, and every conversation it makes is deleted afterwards.
 *
 * Usage:
 *   EVAL_STAFF_EMAIL=... EVAL_STAFF_PASSWORD=... [EVAL_VOLUNTEER_EMAIL=... EVAL_VOLUNTEER_PASSWORD=...] \
 *     node scripts/assistant-eval.mjs [--yes | --dry-run] [--only id,id] [--out run.json] [--compare earlier.json]
 *   BASE defaults to http://localhost:8100. A persona without credentials has its questions skipped.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const root = new URL("..", import.meta.url);
const requireWeb = createRequire(new URL("apps/web/package.json", root));
const YAML = requireWeb("yaml");
const { answerSaysNotFound } = createRequire(new URL("packages/shared/package.json", root))("./dist/index.js");

const BASE = process.env.BASE ?? "http://localhost:8100";
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const DRY = flag("--dry-run");
const only = option("--only")?.split(",").map((s) => s.trim());

const set = YAML.parse(readFileSync(new URL("tests/assistant/questions.yaml", root), "utf8"));
const questions = set.questions.filter((q) => !only || only.includes(q.id));

// ---- HTTP with a cookie jar ----

async function call(jar, path, init = {}) {
  const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await fetch(path.startsWith("http") ? path : BASE + path, {
    redirect: "manual",
    ...init,
    headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}), origin: BASE },
  });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const eq = pair.indexOf("=");
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return res;
}

async function signIn(email, password) {
  const jar = new Map();
  const { csrfToken } = await (await call(jar, "/api/auth/csrf")).json();
  const form = new URLSearchParams({ csrfToken, email, password, callbackUrl: BASE + "/" });
  await call(jar, "/api/auth/callback/credentials", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() });
  if (![...jar.keys()].some((k) => k.includes("session-token"))) throw new Error(`could not sign in as ${email}`);
  return jar;
}

// ---- references ----

const dig = (value, at) => (at ? at.split(".").reduce((v, k) => (v == null ? v : v[k]), value) : value);
const listOf = (value, at) => {
  const v = dig(value, at);
  if (Array.isArray(v)) return v;
  for (const k of ["items", "rows", "data", "results"]) if (Array.isArray(v?.[k])) return v[k];
  return null;
};
const keep = (items, where) =>
  !where ? items : items.filter((it) => Object.entries(where).every(([k, want]) => (Array.isArray(want) ? want.includes(it?.[k]) : it?.[k] === want)));

/** Reads one check's reference: { ok: true, items } or { ok: false, why } (a reason to skip). */
async function reference(jar, spec) {
  const res = await call(jar, `/api/v1${spec.path}`);
  if (res.status !== 200) return { ok: false, why: `${spec.path} answered ${res.status}` };
  const items = listOf(await res.json(), spec.at);
  if (!items) return { ok: false, why: `${spec.path} is not a list${spec.at ? ` at ${spec.at}` : ""}` };
  return { ok: true, items: keep(items, spec.where) };
}

// ---- asking ----

async function ask(jar, question) {
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    const res = await call(jar, "/api/v1/assistant/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question }) });
    if (res.status !== 200) throw new Error(`chat answered ${res.status}`);
    const events = (await res.text())
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)));
    const error = events.find((e) => e.type === "error");
    if (error?.kind === "limited" && attempt === 0) {
      await new Promise((r) => setTimeout(r, 65_000));
      continue;
    }
    return {
      ms: Date.now() - started,
      conversationId: events.find((e) => e.type === "conversation")?.id ?? null,
      text: events.filter((e) => e.type === "text").map((e) => e.delta).join(""),
      lookups: events.filter((e) => e.type === "lookup").map((e) => e.tool),
      proposals: events.filter((e) => e.type === "proposal").map((e) => e.proposal.kind),
      sources: events.find((e) => e.type === "done")?.sources ?? [],
      error: error ? `${error.kind}: ${error.message}` : null,
    };
  }
}

// ---- scoring ----

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const hasNumber = (text, n) => new RegExp(`(^|[^\\d.,])${n}(?![\\d]|[.,]\\d)`).test(text) || (n <= 12 && new RegExp(`\\b${WORDS[n]}\\b`, "i").test(text)) || (n === 0 && /\b(no|none|nothing)\b/i.test(text));
const REFUSAL = /\b(can(no|')t|cannot|unable to|not able to|don't have|do not have|no access|not allowed|permission|outside what i can|isn't something i can)\b/i;
/** The value appears as a whole word (VLAN 1 must not match "10"). */
const mentioned = (text, value) => new RegExp(`(^|[^\\w.])${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w]|\\.\\w)`, "i").test(text);
const linksOf = (a) => [...a.text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]).concat(a.sources.map((s) => s.url));

async function score(q, jar) {
  const problems = [];
  const expected = {};
  for (const kind of ["count", "mentions"]) {
    if (!q[kind]) continue;
    const ref = await reference(jar, q[kind]);
    if (!ref.ok) return { skip: ref.why };
    if (kind === "count") expected.count = ref.items.length;
    else {
      const values = ref.items
        .map((it) => it?.[q.mentions.field])
        .map((v) => (typeof v === "number" ? String(v) : v))
        .filter((v) => typeof v === "string" && v.trim())
        .slice(0, q.mentions.max ?? 5);
      if (!values.length) return { skip: `${q.mentions.path} has no ${q.mentions.field} values` };
      expected.mentions = values;
    }
  }
  if (DRY) return { dry: expected };
  const a = await ask(jar, q.question);
  if (a.error) problems.push(`error ${a.error}`);
  if (expected.count !== undefined && !hasNumber(a.text, expected.count)) problems.push(`expected the number ${expected.count}`);
  if (expected.mentions && !expected.mentions.some((v) => mentioned(a.text, v))) problems.push(`expected one of ${expected.mentions.join(", ")}`);
  for (const re of q.includes ?? []) if (!new RegExp(re, "i").test(a.text)) problems.push(`missing /${re}/`);
  for (const re of q.excludes ?? []) if (new RegExp(re, "i").test(a.text)) problems.push(`contains /${re}/`);
  if (q.links && !linksOf(a).some((l) => q.links.some((p) => l.startsWith(p)))) problems.push(`no link to ${q.links.join(" or ")}`);
  if (q.notFound && !answerSaysNotFound(a.text)) problems.push("did not say it could not find it");
  if (q.refuses && !(REFUSAL.test(a.text) || answerSaysNotFound(a.text))) problems.push("did not refuse");
  if (q.proposes && !a.proposals.includes(q.proposes)) problems.push(`no ${q.proposes} proposal (got ${a.proposals.join(", ") || "none"})`);
  if (q.noProposal && a.proposals.length) problems.push(`proposed ${a.proposals.join(", ")}`);
  if (q.maxLookups !== undefined && a.lookups.length > q.maxLookups) problems.push(`${a.lookups.length} lookups (max ${q.maxLookups})`);
  if (a.conversationId) await call(jar, `/api/v1/assistant/conversations/${a.conversationId}`, { method: "DELETE" });
  return { pass: problems.length === 0, problems, ms: a.ms, lookups: a.lookups, excerpt: a.text.slice(0, 240) };
}

// ---- run ----

const personas = [...new Set(questions.map((q) => q.asks))];
if (!DRY && !flag("--yes")) {
  console.log(`This asks the configured model ${questions.length} questions (${personas.join(", ")}) and spends its budget.`);
  console.log("Run again with --yes, or with --dry-run to read only the references (free).");
  process.exit(2);
}
const jars = {};
for (const p of personas) {
  const email = process.env[`EVAL_${p.toUpperCase()}_EMAIL`];
  const password = process.env[`EVAL_${p.toUpperCase()}_PASSWORD`];
  if (email && password) jars[p] = await signIn(email, password);
}
const firstJar = Object.values(jars)[0];
if (!firstJar) {
  console.error("No persona has credentials (EVAL_STAFF_EMAIL / EVAL_STAFF_PASSWORD ...).");
  process.exit(2);
}
if (!DRY) {
  const status = await (await call(firstJar, "/api/v1/assistant/status")).json();
  if (!status.enabled) {
    console.error("The assistant is not turned on.");
    process.exit(2);
  }
}

const results = {};
for (const q of questions) {
  const jar = jars[q.asks];
  const r = jar ? await score(q, jar) : { skip: `no credentials for ${q.asks}` };
  results[q.id] = r;
  const mark = r.dry ? "REF " : r.skip ? "SKIP" : r.pass ? "PASS" : "FAIL";
  const detail = r.dry ? JSON.stringify(r.dry) : r.skip ?? (r.pass ? `${(r.ms / 1000).toFixed(1)} s, ${r.lookups.length} lookups` : r.problems.join("; "));
  console.log(`${mark}  ${q.id.padEnd(28)} ${detail}`);
  if (r.pass === false) console.log(`      ${r.excerpt.replace(/\s+/g, " ")}`);
}

const scored = Object.values(results).filter((r) => r.pass !== undefined);
if (!DRY) {
  const passed = scored.filter((r) => r.pass).length;
  const times = scored.map((r) => r.ms).sort((a, b) => a - b);
  console.log(`\n${passed}/${scored.length} passed, ${Object.values(results).filter((r) => r.skip).length} skipped; median ${times.length ? (times[Math.floor(times.length / 2)] / 1000).toFixed(1) : "-"} s`);
}
const earlier = option("--compare");
if (earlier) {
  const before = JSON.parse(readFileSync(earlier, "utf8"));
  for (const [id, r] of Object.entries(results)) {
    const b = before[id];
    if (b && b.pass !== undefined && r.pass !== undefined && b.pass !== r.pass) console.log(`${r.pass ? "FIXED " : "BROKE "} ${id}`);
  }
}
const out = option("--out");
if (out) writeFileSync(out, JSON.stringify(results, null, 2));
process.exit(scored.some((r) => !r.pass) ? 1 : 0);
