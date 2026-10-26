import { z } from "zod";
import { ExprError, exprNames, parseExpr } from "./expr";
import { ParseError, splitPath } from "./parse";

/**
 * The service template format (docs/service-monitoring.md section 3). A template says what to ask a service, how to read
 * the answer, which numbers matter and when to complain; the engine (`engine.ts`) and the API's poller do the rest.
 * Stored as JSON (validated here); people may write it as YAML, which the web and the import route turn into this.
 *
 * Placeholders `{{key}}` take an input's value (`{{host}}` is the host's address, `{{login.user}}` /
 * `{{login.password}}` a login input's parts). How a value is put in depends on where it goes, and is the engine's job,
 * never the template's: shell-quoted in an ssh command, refused in a URL's host if it holds anything but a host name,
 * never placed in a SQL query (a query is fixed text, or one whole text input). A SECRET (a `secret` input, a login's
 * password) may only go in headers, a password field or an SNMP community, never in a URL or a command line, where it would
 * end up in logs and process lists.
 */

const KEY = /^[a-z][a-z0-9_]{0,47}$/;
const keySchema = z.string().regex(KEY, "lower-case letters, digits and _ (starting with a letter), at most 48");
const text = (max: number) => z.string().max(max);
const seconds = z.number().int().min(0).max(86_400);

export const SERVICE_INPUT_TYPES = ["string", "text", "number", "bool", "secret", "select", "login"] as const;
export type ServiceInputType = (typeof SERVICE_INPUT_TYPES)[number];

export const serviceInputSchema = z.object({
  key: keySchema,
  label: text(100).min(1),
  type: z.enum(SERVICE_INPUT_TYPES),
  default: z.union([z.string().max(2000), z.number(), z.boolean()]).optional(),
  options: z.array(text(100)).max(50).optional(),
  required: z.boolean().optional(),
  help: text(500).optional(),
});
export type ServiceInput = z.infer<typeof serviceInputSchema>;

export const parserSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("json"), rows: text(300).optional(), columns: text(300).optional() }),
  z.object({ type: z.literal("csv"), delimiter: z.string().length(1).optional(), header: z.boolean().optional() }),
  z.object({ type: z.literal("prometheus") }),
  z.object({ type: z.literal("kv"), separator: z.string().min(1).max(5).optional() }),
  z.object({ type: z.literal("regex"), pattern: text(300).min(1) }),
  z.object({ type: z.literal("lines") }),
  z.object({ type: z.literal("text") }),
]);

const headers = z.record(text(2000)).optional();
const auth = z.object({ user: text(200), password: text(200) }).optional();
const timeoutSec = z.number().int().min(1).max(120).optional();
const optional = z.boolean().optional();

export const collectorSchema = z.discriminatedUnion("transport", [
  z.object({
    transport: z.literal("http"),
    url: text(1000).min(1),
    method: z.enum(["GET", "POST"]).optional(),
    body: text(10_000).optional(),
    headers,
    auth,
    verifyTls: z.union([z.boolean(), text(100)]).optional(),
    parse: parserSchema,
    timeoutSec,
    optional,
  }),
  z.object({
    transport: z.literal("prometheus"),
    url: text(1000).min(1),
    headers,
    auth,
    verifyTls: z.union([z.boolean(), text(100)]).optional(),
    /** Keep only samples whose name starts with one of these (a big exporter can print thousands). */
    keep: z.array(text(200)).max(200).optional(),
    timeoutSec,
    optional,
  }),
  z.object({
    transport: z.literal("ssh"),
    command: text(2000).min(1),
    /** The command needs root: it runs through `sudo -n` (passwordless sudo for the host's login), never elevated silently. */
    sudo: z.boolean().optional(),
    parse: parserSchema,
    timeoutSec,
    optional,
  }),
  z.object({
    transport: z.literal("sql"),
    /** postgres or mysql, or one {{select}} input offering them. */
    engine: z.union([z.enum(["postgres", "mysql"]), text(100)]),
    host: text(300).optional(),
    port: z.union([z.number().int().min(1).max(65_535), text(100)]).optional(),
    database: text(200).optional(),
    user: text(200),
    password: text(200).optional(),
    tls: z.union([z.boolean(), text(100)]).optional(),
    query: text(10_000).min(1),
    timeoutSec,
    optional,
  }),
  z.object({
    transport: z.literal("tcp"),
    host: text(300).optional(),
    port: z.union([z.number().int().min(1).max(65_535), text(100)]),
    send: text(1000).optional(),
    timeoutSec,
    optional,
  }),
  z.object({
    transport: z.literal("snmp"),
    host: text(300).optional(),
    community: text(200),
    version: z.enum(["1", "2c"]).optional(),
    oids: z.record(text(200)),
    timeoutSec,
    optional,
  }),
]);
export type ServiceCollector = z.infer<typeof collectorSchema>;
export type ServiceTransport = ServiceCollector["transport"];

export const SERVICE_AGGS = ["sum", "count", "min", "max", "avg", "first", "last"] as const;
export const SERVICE_METRIC_KINDS = ["gauge", "counter", "state"] as const;

export const serviceMetricSchema = z.object({
  label: text(100).optional(),
  /** Rows of this collector; omitted = a value derived from other metrics with `expr`. */
  from: keySchema.optional(),
  /** Keep rows for which this is true. */
  where: text(1000).optional(),
  /** The row's field to take (a path: `scur`, `value[0][0]`) ... */
  field: text(300).optional(),
  /** ... or an expression over the row's fields. */
  value: text(1000).optional(),
  agg: z.enum(SERVICE_AGGS).optional(),
  /** A counter is turned into a rate per second by the engine. A state is text (MASTER, BACKUP ...). */
  kind: z.enum(SERVICE_METRIC_KINDS).optional(),
  unit: text(20).optional(),
  /** A value computed from metrics declared before this one (and `inputs.<key>`). */
  expr: text(1000).optional(),
});
export type ServiceMetric = z.infer<typeof serviceMetricSchema>;

export const serviceMembersSchema = z.object({
  label: text(100).optional(),
  from: keySchema,
  where: text(1000).optional(),
  key: text(300),
  name: text(300).optional(),
  /** True = this member is fine. Shown, and counted by the `members_down` metric. */
  ok: text(1000).optional(),
  columns: z.record(text(1000)).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});
export type ServiceMembers = z.infer<typeof serviceMembersSchema>;

export const serviceCheckSchema = z.object({
  id: keySchema,
  expr: text(1000).min(1),
  severity: z.enum(["warning", "critical"]),
  /** Seconds the condition must hold before an incident opens. */
  for: seconds.optional(),
  text: text(300).min(1),
});
export type ServiceCheck = z.infer<typeof serviceCheckSchema>;

export const serviceTemplateBodySchema = z.object({
  name: text(100).min(1),
  description: text(1000).optional(),
  /** What the login needs ("a user with pg_monitor"), shown next to the inputs. */
  needs: text(500).optional(),
  detect: z
    .object({
      units: z.array(text(100)).max(20).optional(),
      ports: z.array(z.number().int().min(1).max(65_535)).max(20).optional(),
    })
    .optional(),
  inputs: z.array(serviceInputSchema).max(40),
  collect: z.record(collectorSchema),
  metrics: z.record(serviceMetricSchema),
  members: serviceMembersSchema.optional(),
  checks: z.array(serviceCheckSchema).max(50),
  display: z
    .object({
      cards: z.array(keySchema).max(12).optional(),
      charts: z.array(z.object({ title: text(100), metrics: z.array(keySchema).min(1).max(6) })).max(12).optional(),
    })
    .optional(),
});
export type ServiceTemplateBody = z.infer<typeof serviceTemplateBodySchema>;

const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]*)(?:\.(user|password))?\s*\}\}/g;

/** Every `{{name}}` (and `{{login.part}}`) in a string. */
export function placeholders(s: string): Array<{ key: string; part: "user" | "password" | null }> {
  return [...s.matchAll(PLACEHOLDER)].map((m) => ({ key: m[1]!, part: (m[2] as "user" | "password" | undefined) ?? null }));
}

/** Where in a collector a placeholder is: decides what it may hold. */
type Slot = "url" | "command" | "secret_ok" | "plain" | "query";

function collectorSlots(c: ServiceCollector): Array<{ slot: Slot; value: string; where: string }> {
  const out: Array<{ slot: Slot; value: string; where: string }> = [];
  const add = (slot: Slot, value: unknown, where: string) => {
    if (typeof value === "string") out.push({ slot, value, where });
  };
  switch (c.transport) {
    case "http":
    case "prometheus":
      add("url", c.url, "url");
      for (const [k, v] of Object.entries(c.headers ?? {})) add("secret_ok", v, `header ${k}`);
      if (c.auth) {
        add("plain", c.auth.user, "user");
        add("secret_ok", c.auth.password, "password");
      }
      add("plain", c.verifyTls, "verifyTls");
      if (c.transport === "http") {
        add("plain", c.body, "body");
        if (c.parse.type === "json") {
          add("plain", c.parse.rows, "parse rows");
          add("plain", c.parse.columns, "parse columns");
        }
      }
      break;
    case "ssh":
      add("command", c.command, "command");
      break;
    case "sql":
      add("plain", c.engine, "engine");
      add("plain", c.host, "host");
      add("plain", c.port, "port");
      add("plain", c.database, "database");
      add("plain", c.user, "user");
      add("secret_ok", c.password, "password");
      add("plain", c.tls, "tls");
      add("query", c.query, "query");
      break;
    case "tcp":
      add("plain", c.host, "host");
      add("plain", c.port, "port");
      add("plain", c.send, "send");
      break;
    case "snmp":
      add("plain", c.host, "host");
      add("secret_ok", c.community, "community");
      break;
    default:
      break;
  }
  return out;
}

/**
 * Why a query is not one that only reads (null = fine): it must start with SELECT, WITH, SHOW, EXPLAIN, VALUES, TABLE or
 * DESCRIBE, and never write a file (`INTO OUTFILE`). The sql transport also runs it in a read-only transaction, but MySQL
 * commits DDL implicitly, outside any transaction, so a CREATE or DROP must never get that far.
 */
export function sqlReadProblem(query: string): string | null {
  const first = query.replace(/^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/|\()*/, "").split(/[\s(;]/)[0]?.toUpperCase() ?? "";
  if (!["SELECT", "WITH", "SHOW", "EXPLAIN", "VALUES", "TABLE", "DESCRIBE", "DESC"].includes(first)) {
    return `only a query that reads may run (SELECT, WITH, SHOW ...), not ${first || "an empty one"}`;
  }
  if (/\binto\s+(?:out|dump)file\b/i.test(query)) return "a query may not write a file";
  return null;
}

/** True when a template runs commands on the host (an ssh collector): saving or attaching it needs a confirmation. */
export function templateRunsCommands(body: ServiceTemplateBody): boolean {
  return Object.values(body.collect).some((c) => c.transport === "ssh");
}

/** The commands a template runs, for the confirmation and its diff. */
export function templateCommands(body: ServiceTemplateBody): string[] {
  return Object.entries(body.collect)
    .filter(([, c]) => c.transport === "ssh")
    .map(([k, c]) => `${k}: ${(c as { sudo?: boolean }).sudo ? "sudo -n " : ""}${(c as { command: string }).command}`);
}

/**
 * Everything wrong with a template, in words (empty = fine). Checked on save, on import and in the editor as you type.
 * Beyond the shape: names refer to things that exist, metrics are declared before the expressions that use them,
 * expressions parse, and secrets go only where secrets may go.
 */
export function serviceTemplateProblems(raw: unknown): string[] {
  const parsed = serviceTemplateBodySchema.safeParse(raw);
  if (!parsed.success) {
    return parsed.error.issues.slice(0, 20).map((i) => `${i.path.join(".") || "template"}: ${i.message}`);
  }
  const t = parsed.data;
  const problems: string[] = [];
  const inputs = new Map(t.inputs.map((i) => [i.key, i]));
  if (inputs.size !== t.inputs.length) problems.push("two inputs have the same key");
  if (inputs.has("host")) problems.push('"host" is the host\'s own address; an input cannot use that key');
  for (const i of t.inputs) {
    if (i.type === "select" && !(i.options ?? []).length) problems.push(`input ${i.key}: a select needs options`);
    if (i.type === "secret" && i.default !== undefined && i.default !== "") problems.push(`input ${i.key}: a secret cannot have a default`);
  }
  const collectors = Object.keys(t.collect);
  if (!collectors.length) problems.push("a template needs at least one collector");
  for (const k of collectors) if (!KEY.test(k)) problems.push(`collector "${k}": lower-case letters, digits and _`);

  const expr = (where: string, src: string | undefined, known: (name: string) => boolean) => {
    if (src === undefined) return;
    try {
      const names = exprNames(parseExpr(src));
      for (const n of names) {
        if (n.startsWith("inputs.")) {
          if (!inputs.has(n.slice(7))) problems.push(`${where}: no input "${n.slice(7)}"`);
        } else if (!known(n)) problems.push(`${where}: "${n}" is not known here`);
      }
    } catch (e) {
      if (e instanceof ExprError) problems.push(`${where}: ${e.message}`);
      else throw e;
    }
  };

  for (const [name, c] of Object.entries(t.collect)) {
    if (c.transport === "sql" && !placeholders(c.query).length) {
      const why = sqlReadProblem(c.query);
      if (why) problems.push(`collector ${name}: ${why}`);
    }
    if (c.transport === "sql" && c.engine !== "postgres" && c.engine !== "mysql") {
      const ps = placeholders(c.engine);
      const input = ps.length === 1 && c.engine.trim() === `{{${ps[0]!.key}}}` ? inputs.get(ps[0]!.key) : undefined;
      const opts = input?.type === "select" ? input.options ?? [] : [];
      if (!input || !opts.length || opts.some((o) => o !== "postgres" && o !== "mysql")) {
        problems.push(`collector ${name}: engine is postgres, mysql, or one {{select}} input offering only those`);
      }
    }
    if ("parse" in c && c.parse.type === "json" && c.parse.rows && !c.parse.rows.includes("{{")) {
      try {
        splitPath(c.parse.rows);
      } catch (e) {
        if (e instanceof ParseError) problems.push(`collector ${name}: ${e.message}`);
      }
    }
    if ("parse" in c && c.parse.type === "regex") {
      try {
        new RegExp(c.parse.pattern);
      } catch (e) {
        problems.push(`collector ${name}: the pattern does not read (${(e as Error).message})`);
      }
    }
    for (const s of collectorSlots(c)) {
      for (const p of placeholders(s.value)) {
        if (p.key === "host") {
          if (p.part) problems.push(`collector ${name} ${s.where}: {{host}} has no parts`);
          continue;
        }
        const input = inputs.get(p.key);
        if (!input) {
          problems.push(`collector ${name} ${s.where}: no input "${p.key}"`);
          continue;
        }
        if (p.part && input.type !== "login") problems.push(`collector ${name} ${s.where}: "${p.key}" is not a login`);
        if (!p.part && input.type === "login") problems.push(`collector ${name} ${s.where}: use {{${p.key}.user}} or {{${p.key}.password}}`);
        const secret = input.type === "secret" || (input.type === "login" && p.part === "password");
        if (secret && s.slot !== "secret_ok") problems.push(`collector ${name} ${s.where}: a secret may only go in a header, a password or a community`);
        if (s.slot === "query" && (s.value.trim() !== `{{${p.key}}}` || input.type !== "text")) {
          problems.push(`collector ${name} query: a query is fixed text, or exactly one {{text input}}`);
        }
      }
    }
    if (c.transport === "http" || c.transport === "prometheus") {
      // A url that is wholly an input ({{url}}) is checked when it is filled in.
      if (!c.url.startsWith("{{") && !/^https?:\/\//i.test(c.url)) problems.push(`collector ${name}: the url must start with http:// or https://`);
    }
  }

  // Metrics in declaration order: an expr may read metrics above it.
  const seen = new Set<string>();
  const metricKeys = Object.keys(t.metrics);
  for (const k of metricKeys) if (!KEY.test(k)) problems.push(`metric "${k}": lower-case letters, digits and _`);
  for (const [key, m] of Object.entries(t.metrics)) {
    const where = `metric ${key}`;
    if (m.from) {
      if (!t.collect[m.from]) problems.push(`${where}: no collector "${m.from}"`);
      if (m.expr) problems.push(`${where}: give either from (rows) or expr (other metrics), not both`);
      if (m.field && m.value) problems.push(`${where}: give field or value, not both`);
      const agg = m.agg ?? "first";
      if (agg !== "count" && !m.field && !m.value) problems.push(`${where}: needs a field or a value (or agg: count)`);
      if (m.kind === "state" && !["first", "last"].includes(agg)) problems.push(`${where}: a state takes agg first or last`);
      expr(`${where} where`, m.where, () => true);
      expr(`${where} value`, m.value, () => true);
    } else if (m.expr) {
      if (m.kind === "counter") problems.push(`${where}: a counter must come from rows`);
      expr(where, m.expr, (n) => seen.has(n) || n === "members_down" || n === "members_total");
    } else {
      problems.push(`${where}: needs from (rows) or expr`);
    }
    seen.add(key);
  }
  if (t.members) {
    if (!t.collect[t.members.from]) problems.push(`members: no collector "${t.members.from}"`);
    expr("members where", t.members.where, () => true);
    expr("members ok", t.members.ok, () => true);
    for (const [col, src] of Object.entries(t.members.columns ?? {})) expr(`members column ${col}`, src, () => true);
  }
  const knownForChecks = (n: string) => seen.has(n) || (t.members !== undefined && (n === "members_down" || n === "members_total"));
  const checkIds = new Set<string>();
  for (const c of t.checks) {
    if (checkIds.has(c.id)) problems.push(`two checks have the id "${c.id}"`);
    checkIds.add(c.id);
    expr(`check ${c.id}`, c.expr, knownForChecks);
    for (const p of placeholders(c.text)) if (!knownForChecks(p.key)) problems.push(`check ${c.id} text: "{{${p.key}}}" is not a metric`);
  }
  for (const k of t.display?.cards ?? []) if (!seen.has(k)) problems.push(`display cards: no metric "${k}"`);
  for (const ch of t.display?.charts ?? []) for (const k of ch.metrics) if (!seen.has(k)) problems.push(`display chart ${ch.title}: no metric "${k}"`);
  return problems;
}

/** Template keys: a slug. Built-ins are plain names; a fork or a custom template must not take one of theirs. */
export const serviceTemplateKeySchema = z.string().regex(/^[a-z][a-z0-9-]{1,47}$/, "lower-case letters, digits and -, 2 to 48");

export const serviceTemplateSaveSchema = z.object({
  key: serviceTemplateKeySchema,
  body: z.unknown(),
  /** The commands the person was shown and confirmed (see templateCommands). Required when the template runs commands. */
  confirmCommands: z.array(z.string()).optional(),
});
export type ServiceTemplateSave = z.infer<typeof serviceTemplateSaveSchema>;

export interface ServiceTemplate {
  key: string;
  source: "builtin" | "custom";
  forkedFrom: string | null;
  version: number;
  runsCommands: boolean;
  body: ServiceTemplateBody;
  updatedAt: string | null;
  instances: number;
}
