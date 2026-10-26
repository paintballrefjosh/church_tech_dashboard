import { lookup } from "node:dns/promises";
import { connect as tcpConnect, isIP } from "node:net";
import * as snmp from "net-snmp";
import { Agent, request } from "undici";
import { createConnection as mysqlConnection } from "mysql2/promise";
import {
  blockedAddress,
  hideSecrets,
  parseOutput,
  placeholders,
  prometheusRows,
  renderPlaceholders,
  shellQuote,
  sqlReadProblem,
  type PlaceholderValue,
  type RenderMode,
  type Row,
  type ServiceCollector,
} from "@church/shared";
import { createPool } from "@church/shared/db";
import type { QueryArrayConfig } from "pg";
import { sshExec } from "../infra/collectors/ssh";
import type { CollectContext } from "../infra/collectors/types";

/**
 * The network half of a service template: run one collector against a host and turn what came back into rows (the pure
 * engine in packages/shared/src/service-monitoring does the rest). Every placeholder goes through `renderPlaceholders` in
 * the mode its place needs (shell-quoted in a command, checked in an address), every address is checked before anything
 * is sent, nothing ever writes: SQL runs in a read-only transaction, HTTP follows no redirects, and every transport has
 * a clock and a cap on what it reads.
 */

const MAX_BODY = 5 * 1024 * 1024;
const MAX_ROWS = 20_000;
const DEFAULT_TIMEOUT_SEC = 15;

export interface InstanceRunContext {
  /** The host's address (the infra target's `host`). */
  host: string;
  /** For ssh: the host's own login, options and pinned key. */
  ssh: CollectContext;
  vars: Record<string, PlaceholderValue>;
  secrets: string[];
}

export interface CollectorRun {
  rows: Row[] | null;
  error: string | null;
  /** What came back, before parsing (the Test button shows it); secrets hidden, cut at 20000 characters. */
  raw: string | null;
  ms: number;
}

export class TransportError extends Error {}

const verifyingAgent = new Agent({ connect: { rejectUnauthorized: true } });
const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });

const STACK_NAMES = new Set(["api", "web", "proxy", "caddy", "meilisearch", "garage", "monitor", "cockroach", "localhost"]);

/**
 * A host the dashboard may contact for a service: never loopback, link-local (cloud metadata) or "any", never one of
 * this stack's own containers (a one-word name resolves to a container on the compose network), also after DNS.
 * Private LAN addresses are the point.
 */
export async function assertServiceHost(host: string): Promise<void> {
  const h = host.trim().replace(/^\[|\]$/g, "").toLowerCase();
  if (!h) throw new TransportError("no host to connect to");
  if (blockedAddress(h)) throw new TransportError(`${h} is not an address the dashboard may contact`);
  if (isIP(h) === 0) {
    if (STACK_NAMES.has(h) || /^cockroach/.test(h) || !h.includes(".")) {
      throw new TransportError(`"${h}" is not allowed: use the host's full name or its address`);
    }
    let addrs: Array<{ address: string }>;
    try {
      addrs = await lookup(h, { all: true });
    } catch {
      throw new TransportError(`${h} could not be found (DNS)`);
    }
    if (addrs.some((a) => blockedAddress(a.address))) throw new TransportError(`${h} resolves to an address the dashboard may not contact`);
  }
}

function render(s: string, ctx: InstanceRunContext, mode: RenderMode): string {
  return renderPlaceholders(s, ctx.vars, mode);
}

/** "true"/"yes"/"1"/"on" (a bool input renders as "true" or "false"). */
function flag(v: unknown, fallback: boolean): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v !== "string") return fallback;
  const s = v.trim().toLowerCase();
  if (s === "") return fallback;
  return s === "true" || s === "yes" || s === "1" || s === "on";
}

function renderedFlag(v: boolean | string | undefined, ctx: InstanceRunContext, fallback: boolean): boolean {
  return typeof v === "string" ? flag(render(v, ctx, "plain"), fallback) : flag(v, fallback);
}

function renderedPort(v: number | string | undefined, ctx: InstanceRunContext, fallback: number): number {
  if (v === undefined) return fallback;
  const n = typeof v === "number" ? v : Number(render(v, ctx, "plain"));
  if (!Number.isInteger(n) || n < 1 || n > 65_535) throw new TransportError(`"${v}" is not a port`);
  return n;
}

function renderedHost(v: string | undefined, ctx: InstanceRunContext): string {
  return v === undefined ? ctx.host : render(v, ctx, "plain").trim() || ctx.host;
}

/** A header whose placeholders all came out empty (an optional token left blank) is not sent at all. */
function renderHeaders(headers: Record<string, string> | undefined, ctx: InstanceRunContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    const ps = placeholders(v);
    if (ps.length && ps.every((p) => !ctx.vars[p.part ? `${p.key}.${p.part}` : p.key]?.value)) continue;
    out[k.toLowerCase()] = render(v, ctx, "header");
  }
  return out;
}

async function httpGetText(
  c: Extract<ServiceCollector, { transport: "http" | "prometheus" }>,
  ctx: InstanceRunContext,
  timeoutMs: number,
): Promise<string> {
  const url = render(c.url, ctx, "url");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TransportError(`"${hideSecrets(url, ctx.secrets)}" is not an address`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new TransportError("only http and https addresses");
  if (parsed.username || parsed.password) throw new TransportError("put a login in the user and password fields, not in the address");
  await assertServiceHost(parsed.hostname);

  const headers = renderHeaders(c.headers, ctx);
  if (c.auth) {
    const user = render(c.auth.user, ctx, "plain");
    const password = render(c.auth.password, ctx, "plain");
    if (password) headers.authorization = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
  }
  const method = c.transport === "http" ? c.method ?? "GET" : "GET";
  const body = c.transport === "http" && c.body !== undefined && method === "POST" ? render(c.body, ctx, "plain") : undefined;
  if (c.transport === "prometheus" && !headers.accept) headers.accept = "text/plain;version=0.0.4";

  const res = await request(parsed, {
    method,
    headers,
    body,
    dispatcher: renderedFlag(c.verifyTls, ctx, true) ? verifyingAgent : insecureAgent,
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) {
      res.body.destroy();
      throw new TransportError("the answer is larger than 5 MB");
    }
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (res.statusCode >= 300 && res.statusCode < 400) throw new TransportError(`answered ${res.statusCode} (a redirect, not followed): give the final address`);
  if (res.statusCode === 401 || res.statusCode === 403) throw new TransportError(`answered ${res.statusCode}: the login or token was refused`);
  if (res.statusCode >= 400) throw new TransportError(`answered ${res.statusCode}`);
  return text;
}

async function sshText(c: Extract<ServiceCollector, { transport: "ssh" }>, ctx: InstanceRunContext, timeoutMs: number): Promise<string> {
  if (!ctx.ssh.credential) throw new TransportError("the host has no SSH login");
  // Never trust a key on a command collector's first connect: the host's own poll pins it first.
  if (!ctx.ssh.knownHostKey) throw new TransportError("the host's SSH key is not recorded yet (wait for the host's first poll)");
  const cmd = render(c.command, ctx, "shell");
  // sudo -n: passwordless sudo only, never a prompt and never a stored password.
  const full = c.sudo ? `sudo -n sh -c ${shellQuote(cmd)}` : cmd;
  const res = await sshExec(ctx.ssh, full, { execTimeoutMs: timeoutMs });
  if (res.code !== 0) {
    const why = (res.stderr || res.stdout).trim().split("\n")[0]?.slice(0, 300) ?? "";
    if (c.sudo && /a password is required|interactive authentication|not in the sudoers/i.test(why)) {
      throw new TransportError(`sudo refused (${why}): the host's login needs passwordless sudo for this command`);
    }
    throw new TransportError(`the command exited with ${res.code ?? "a signal"}${why ? `: ${why}` : ""}`);
  }
  return res.stdout;
}

function withFirst(rows: Row[]): Row[] {
  // `_first`: the first column, so "a query that returns a number" need not name its column.
  return rows.slice(0, MAX_ROWS).map((r) => {
    const keys = Object.keys(r);
    return { ...r, _first: keys.length ? r[keys[0]!] : null };
  });
}

async function sqlRows(c: Extract<ServiceCollector, { transport: "sql" }>, ctx: InstanceRunContext, timeoutMs: number): Promise<Row[]> {
  const engine = render(c.engine, ctx, "plain");
  if (engine !== "postgres" && engine !== "mysql") throw new TransportError(`"${engine}" is not a database engine (postgres or mysql)`);
  const host = renderedHost(c.host, ctx);
  await assertServiceHost(host);
  const port = renderedPort(c.port, ctx, engine === "postgres" ? 5432 : 3306);
  const user = render(c.user, ctx, "plain");
  const password = c.password !== undefined ? render(c.password, ctx, "plain") : "";
  const database = c.database !== undefined ? render(c.database, ctx, "plain") : "";
  const tls = renderedFlag(c.tls, ctx, false);
  const query = render(c.query, ctx, "plain");
  if (!user) throw new TransportError("no database login");
  const notRead = sqlReadProblem(query);
  if (notRead) throw new TransportError(notRead);

  if (engine === "postgres") {
    // Its own one-connection pool for this read, never the app's (docs/service-monitoring.md section 11). The monitored
    // server's certificate is not checked when TLS is on: the dashboard has no way to trust a private CA here.
    const hostPart = isIP(host) === 6 ? `[${host}]` : host;
    const url =
      // No password at all (not an empty one) when the login has none: a trust or certificate login.
      `postgresql://${encodeURIComponent(user)}${password ? `:${encodeURIComponent(password)}` : ""}@${hostPart}:${port}/${encodeURIComponent(database || "postgres")}` +
      `?sslmode=${tls ? "no-verify" : "disable"}&application_name=church-service-monitor`;
    const pool = createPool({ name: "service-monitor", url, max: 1, queryTimeoutMs: timeoutMs, retryAttempts: 1, log: () => undefined });
    try {
      const client = await pool.connect();
      try {
        await client.query("BEGIN READ ONLY");
        await client.query(`SET LOCAL statement_timeout = ${Math.max(1000, timeoutMs - 500)}`);
        // The extended protocol takes exactly one statement: "SELECT 1; COMMIT; DROP ..." is refused by the server. (An empty
        // `values` is not enough: pg then still sends a simple query, which runs every statement in it.)
        const config: QueryArrayConfig & { queryMode: "extended" } = { text: query, rowMode: "array", queryMode: "extended" };
        const res = await client.query(config);
        await client.query("ROLLBACK");
        const names = res.fields.map((f) => f.name);
        return withFirst((res.rows as unknown[][]).map((r) => Object.fromEntries(names.map((n, i) => [n, plainValue(r[i])]))));
      } finally {
        client.release();
      }
    } finally {
      await pool.end().catch(() => undefined);
    }
  }

  const conn = await mysqlConnection({
    host,
    port,
    user,
    password,
    database: database || undefined,
    ssl: tls ? { rejectUnauthorized: false } : undefined,
    connectTimeout: timeoutMs,
    multipleStatements: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
  });
  try {
    // MySQL calls the limit max_execution_time (ms), MariaDB max_statement_time (s); one of them is refused.
    await conn.query(`SET SESSION max_execution_time = ${timeoutMs}`).catch(() => undefined);
    await conn.query(`SET SESSION max_statement_time = ${Math.ceil(timeoutMs / 1000)}`).catch(() => undefined);
    // Session-wide too: DDL commits implicitly and starts a new transaction, which must be read-only as well.
    await conn.query("SET SESSION TRANSACTION READ ONLY");
    await conn.query("START TRANSACTION READ ONLY");
    const [rows] = await conn.query({ sql: query, timeout: timeoutMs, rowsAsArray: false });
    await conn.query("ROLLBACK").catch(() => undefined);
    if (!Array.isArray(rows)) return [];
    return withFirst((rows as Array<Record<string, unknown>>).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, plainValue(v)]))));
  } finally {
    await conn.end().catch(() => conn.destroy());
  }
}

/** Database values as plain JSON (numbers stay numbers or numeric strings, dates and buffers become text). */
function plainValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return v.toString("utf8");
  if (typeof v === "object") return JSON.stringify(v);
  return v;
}

async function tcpRows(c: Extract<ServiceCollector, { transport: "tcp" }>, ctx: InstanceRunContext, timeoutMs: number): Promise<Row[]> {
  const host = renderedHost(c.host, ctx);
  await assertServiceHost(host);
  const port = renderedPort(c.port, ctx, 0);
  const send = c.send !== undefined ? render(c.send, ctx, "plain") : "";
  const started = Date.now();
  return new Promise<Row[]>((resolve, reject) => {
    const sock = tcpConnect({ host, port });
    let connectedMs: number | null = null;
    let text = "";
    let done = false;
    let idle: NodeJS.Timeout | null = null;
    const finish = (err: Error | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (idle) clearTimeout(idle);
      sock.destroy();
      if (err && connectedMs === null) reject(err);
      else resolve([{ connected: true, connect_ms: connectedMs, text: text.slice(0, 64 * 1024) }]);
    };
    const timer = setTimeout(() => finish(connectedMs === null ? new TransportError(`no answer on port ${port}`) : null), timeoutMs);
    sock.on("connect", () => {
      connectedMs = Date.now() - started;
      if (send) sock.write(send.replace(/\\r/g, "\r").replace(/\\n/g, "\n"));
      // A banner (or the answer to what was sent) normally comes at once; a silent port is still "connected".
      idle = setTimeout(() => finish(null), 1500);
    });
    // What the service says first is what a template reads: stop half a second after the last data.
    sock.on("data", (d: Buffer) => {
      text += d.toString("utf8");
      if (text.length > 64 * 1024) return finish(null);
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => finish(null), 500);
    });
    sock.on("end", () => finish(null));
    sock.on("error", (e) => finish(new TransportError(`port ${port}: ${e.message}`)));
  });
}

type SnmpSession = {
  get(oids: string[], cb: (err: Error | null, varbinds: Array<{ oid: string; value: unknown; type: number }>) => void): void;
  close(): void;
};

async function snmpRows(c: Extract<ServiceCollector, { transport: "snmp" }>, ctx: InstanceRunContext, timeoutMs: number): Promise<Row[]> {
  const host = renderedHost(c.host, ctx);
  await assertServiceHost(host);
  const community = render(c.community, ctx, "plain");
  const names = Object.keys(c.oids);
  const oids = names.map((n) => c.oids[n]!.replace(/^\./, ""));
  for (const o of oids) if (!/^\d+(\.\d+)+$/.test(o)) throw new TransportError(`"${o}" is not a numeric OID`);
  const sess = snmp.createSession(host, community, {
    version: c.version === "1" ? snmp.Version1 : snmp.Version2c,
    timeout: Math.min(timeoutMs, 10_000),
    retries: 1,
  }) as unknown as SnmpSession;
  try {
    const varbinds = await new Promise<Array<{ oid: string; value: unknown; type: number }>>((resolve, reject) =>
      sess.get(oids, (err, vb) => (err ? reject(new TransportError(`SNMP: ${err.message}`)) : resolve(vb))),
    );
    const row: Row = {};
    varbinds.forEach((vb, i) => {
      // noSuchObject, noSuchInstance, endOfMibView (types 128-130): the agent has no such value.
      const bad = vb.type >= 128 && vb.type <= 130;
      row[names[i]!] = bad ? null : plainValue(vb.value);
    });
    return [row];
  } finally {
    try {
      sess.close();
    } catch {
      /* best effort */
    }
  }
}

/** Runs one collector. Never throws: a failure is `{rows: null, error}` with secrets hidden from the message. */
export async function runCollector(c: ServiceCollector, ctx: InstanceRunContext, opts: { keepRaw?: boolean } = {}): Promise<CollectorRun> {
  const started = Date.now();
  const timeoutMs = (c.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000;
  let raw: string | null = null;
  const cut = (s: string) => (opts.keepRaw ? hideSecrets(s.slice(0, 20_000), ctx.secrets) : null);
  try {
    let rows: Row[];
    switch (c.transport) {
      case "http": {
        const text = await httpGetText(c, ctx, timeoutMs);
        raw = cut(text);
        const spec = c.parse.type === "json" ? { ...c.parse, rows: c.parse.rows && render(c.parse.rows, ctx, "plain"), columns: c.parse.columns && render(c.parse.columns, ctx, "plain") } : c.parse;
        rows = parseOutput(text, spec);
        break;
      }
      case "prometheus": {
        const text = await httpGetText(c, ctx, timeoutMs);
        raw = cut(text);
        const all = prometheusRows(text);
        rows = c.keep?.length ? all.filter((r) => c.keep!.some((p) => String(r.__name__).startsWith(p))) : all;
        break;
      }
      case "ssh": {
        const text = await sshText(c, ctx, timeoutMs);
        raw = cut(text);
        rows = parseOutput(text, c.parse);
        break;
      }
      case "sql":
        rows = await sqlRows(c, ctx, timeoutMs);
        raw = cut(JSON.stringify(rows.slice(0, 50), null, 1));
        break;
      case "tcp":
        rows = await tcpRows(c, ctx, timeoutMs);
        raw = cut(String(rows[0]?.text ?? ""));
        break;
      case "snmp":
        rows = await snmpRows(c, ctx, timeoutMs);
        raw = cut(JSON.stringify(rows[0] ?? {}));
        break;
      default:
        throw new TransportError("unknown transport");
    }
    return { rows: rows.slice(0, MAX_ROWS), error: null, raw, ms: Date.now() - started };
  } catch (e) {
    const err = e as Error & { code?: string; cause?: Error };
    let msg = err.name === "TimeoutError" || err.name === "AbortError" ? `no answer within ${timeoutMs / 1000} s` : err.message || String(err);
    if (err.cause?.message && /fetch failed|other side closed/i.test(msg)) msg = err.cause.message;
    return { rows: null, error: hideSecrets(msg, ctx.secrets).slice(0, 500), raw, ms: Date.now() - started };
  }
}
