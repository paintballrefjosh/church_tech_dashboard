import { connect as tcpConnect } from "node:net";
import { spawn } from "node:child_process";
import { Resolver } from "node:dns/promises";

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  info: string;
}

export interface ProbeContext {
  target: string;
  options: Record<string, unknown>;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * HTTP probe. Treats any 2xx (or the configured expectedStatus) as success.
 * Optional `expectBody` substring check applied after status passes.
 */
export async function probeHttp(ctx: ProbeContext): Promise<ProbeResult> {
  const opts = (ctx.options ?? {}) as {
    method?: string;
    expectedStatus?: number;
    timeoutMs?: number;
    expectBody?: string;
    authorization?: string;
  };
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    const headers: Record<string, string> = {};
    if (opts.authorization) headers["authorization"] = opts.authorization;
    const res = await fetch(ctx.target, {
      method: opts.method ?? "GET",
      headers,
      signal: controller.signal,
      // Don't follow huge redirects forever.
      redirect: "follow",
    });
    const latency = Date.now() - start;
    const expected = opts.expectedStatus ?? null;
    const statusOk = expected ? res.status === expected : res.status >= 200 && res.status < 400;
    if (!statusOk) {
      return { ok: false, latencyMs: latency, info: `HTTP ${res.status}` };
    }
    if (opts.expectBody) {
      const body = await res.text();
      if (!body.includes(opts.expectBody)) {
        return { ok: false, latencyMs: latency, info: `body match failed` };
      }
    }
    return { ok: true, latencyMs: latency, info: `HTTP ${res.status}` };
  } catch (err) {
    const latency = Date.now() - start;
    const e = err as { name?: string; code?: string; message?: string };
    if (e.name === "AbortError") {
      return { ok: false, latencyMs: latency, info: `timeout after ${timeoutMs}ms` };
    }
    return { ok: false, latencyMs: latency, info: e.code ?? e.message ?? "fetch error" };
  } finally {
    clearTimeout(timer);
  }
}

/** TCP probe. Target shape: "host:port". */
export function probeTcp(ctx: ProbeContext): Promise<ProbeResult> {
  const opts = (ctx.options ?? {}) as { timeoutMs?: number };
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const [host, portStr] = ctx.target.split(":");
  const port = parseInt(portStr ?? "", 10);
  if (!host || !port) {
    return Promise.resolve({ ok: false, latencyMs: 0, info: "invalid target (expected host:port)" });
  }
  return new Promise((resolve) => {
    const start = Date.now();
    const sock = tcpConnect({ host, port });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve({ ok: false, latencyMs: Date.now() - start, info: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    sock.once("connect", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve({ ok: true, latencyMs: Date.now() - start, info: "connected" });
    });
    sock.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const e = err as { code?: string; message: string };
      resolve({ ok: false, latencyMs: Date.now() - start, info: e.code ?? e.message });
    });
  });
}

/**
 * ICMP via the `ping` shell command. We don't open a raw socket because that
 * needs CAP_NET_RAW; depending on the host's `ping` binary keeps the
 * container unprivileged. Counts as ok when at least one packet returns.
 */
export function probeIcmp(ctx: ProbeContext): Promise<ProbeResult> {
  const opts = (ctx.options ?? {}) as { timeoutMs?: number };
  const timeoutMs = opts.timeoutMs ?? 3_000;
  const deadlineSec = Math.max(1, Math.ceil(timeoutMs / 1000));
  return new Promise((resolve) => {
    const start = Date.now();
    // -c 1: send one packet; -W: per-reply timeout in seconds.
    const child = spawn("ping", ["-c", "1", "-W", String(deadlineSec), ctx.target], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    const killTimer = setTimeout(() => child.kill(), timeoutMs + 1_000);
    child.on("close", (code) => {
      clearTimeout(killTimer);
      const latency = Date.now() - start;
      if (code === 0) {
        // Try to grab the "time=..." figure from the first reply line.
        const m = /time=([\d.]+)\s*ms/.exec(stdout);
        return resolve({
          ok: true,
          latencyMs: m ? Math.round(parseFloat(m[1] ?? "0")) : latency,
          info: "1/1 replies",
        });
      }
      const reason = (stderr || stdout).split("\n").find((l) => l.trim()) ?? `ping exit ${code}`;
      resolve({ ok: false, latencyMs: latency, info: reason.trim() });
    });
    child.on("error", (err) => {
      clearTimeout(killTimer);
      resolve({
        ok: false,
        latencyMs: Date.now() - start,
        info: (err as Error).message,
      });
    });
  });
}

/**
 * DNS probe. Resolves `target` as `recordType` (A, AAAA, CNAME, MX, TXT) via
 * `resolver` when set (a specific DNS server, e.g. one cluster node) or the
 * system resolver. Fails when resolution errors or comes back empty, or when
 * `expectedValue` is set and no answer contains it. Options mirror
 * `monitorDnsOptionsSchema` in packages/shared.
 */
export async function probeDns(ctx: ProbeContext): Promise<ProbeResult> {
  const opts = (ctx.options ?? {}) as {
    recordType?: string;
    expectedValue?: string;
    resolver?: string;
    timeoutMs?: number;
  };
  const type = (opts.recordType ?? "A").toUpperCase();
  const timeoutMs = opts.timeoutMs ?? 5_000;
  // One try with the full timeout; the hard race below also covers a hung
  // socket, so a dead server can't stall the worker's in-flight slot.
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (opts.resolver) resolver.setServers([opts.resolver]);
    const lookup = async (): Promise<string[]> => {
      switch (type) {
        case "A":
          return resolver.resolve4(ctx.target);
        case "AAAA":
          return resolver.resolve6(ctx.target);
        case "CNAME":
          return resolver.resolveCname(ctx.target);
        case "MX":
          return (await resolver.resolveMx(ctx.target)).map((m) => `${m.priority} ${m.exchange}`);
        case "TXT":
          return (await resolver.resolveTxt(ctx.target)).map((chunks) => chunks.join(""));
        default:
          throw new Error(`unsupported record type ${type}`);
      }
    };
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs + 500);
    });
    const values = await Promise.race([lookup(), timeout]);
    const latency = Date.now() - start;
    const via = opts.resolver ? ` via ${opts.resolver}` : "";
    if (values.length === 0) return { ok: false, latencyMs: latency, info: `no ${type} records${via}` };
    if (opts.expectedValue && !values.some((v) => v.includes(opts.expectedValue!))) {
      return {
        ok: false,
        latencyMs: latency,
        info: `expected "${opts.expectedValue}" not in ${type} answer${via}: ${values.slice(0, 3).join(", ")}`,
      };
    }
    return { ok: true, latencyMs: latency, info: `${type} ${values.slice(0, 3).join(", ")}${via}` };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { ok: false, latencyMs: Date.now() - start, info: e.code ?? e.message ?? String(err) };
  } finally {
    if (timer) clearTimeout(timer);
    resolver.cancel();
  }
}
