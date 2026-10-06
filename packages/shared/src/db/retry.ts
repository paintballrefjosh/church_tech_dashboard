/**
 * Which database errors are worth retrying, and when it is safe.
 *
 * A node of a database cluster dying, a load balancer moving connections, or a
 * serialization conflict all surface as errors on a request that would succeed
 * a moment later. Retrying is only safe when the statement certainly did not
 * take effect, or when repeating it changes nothing.
 */
export type DbErrorClass =
  /** The statement never reached the database (could not connect, pool wait timed out). Safe to retry anything. */
  | "pre-send"
  /** The database rolled the statement back (serialization failure, deadlock). Safe to retry anything. */
  | "rolled-back"
  /** The connection broke; the statement may or may not have run. Safe to retry only a read. */
  | "ambiguous";

const PRE_SEND_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);
// 57P03: cannot connect now (starting up); 53300: too many connections; 08001/08004: could not establish / rejected.
const PRE_SEND_SQLSTATES = new Set(["57P03", "53300", "08001", "08004"]);
const ROLLED_BACK_SQLSTATES = new Set(["40001", "40P01"]);
// 57P01/57P02: administrator / crash shutdown; 08000/08003/08006: connection exception / failure; 40003: CockroachDB "result is ambiguous".
const AMBIGUOUS_SQLSTATES = new Set(["57P01", "57P02", "08000", "08003", "08006", "40003"]);
const AMBIGUOUS_CODES = new Set(["ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNABORTED"]);

const PRE_SEND_MESSAGES = [
  /timeout exceeded when trying to connect/i, // pg-pool: waited too long for a free connection
  /connection terminated due to connection timeout/i, // pg: the connect attempt timed out
];
const AMBIGUOUS_MESSAGES = [
  /connection terminated unexpectedly/i,
  /server closed the connection unexpectedly/i,
  /terminating connection/i,
  /operation expired/i, // YugabyteDB
  /restart read required/i, // YugabyteDB
  /connection (is )?closed/i,
  /query read timeout/i, // pg: no answer within query_timeout; the statement may have run
];

/** The class of a retryable database error, or null if retrying will not help. */
export function classifyDbError(err: unknown): DbErrorClass | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { code?: unknown; message?: unknown };
  const code = typeof e.code === "string" ? e.code : "";
  const message = typeof e.message === "string" ? e.message : "";

  if (ROLLED_BACK_SQLSTATES.has(code)) return "rolled-back";
  if (PRE_SEND_CODES.has(code) || PRE_SEND_SQLSTATES.has(code)) return "pre-send";
  if (PRE_SEND_MESSAGES.some((re) => re.test(message))) return "pre-send";
  if (AMBIGUOUS_SQLSTATES.has(code) || AMBIGUOUS_CODES.has(code)) return "ambiguous";
  if (AMBIGUOUS_MESSAGES.some((re) => re.test(message))) return "ambiguous";
  return null;
}

/**
 * Whether repeating this statement changes nothing. Deliberately narrow: only a
 * plain SELECT / SHOW / EXPLAIN. A `WITH` can hide a write, so it does not count.
 */
export function isReadOnlyStatement(text: string): boolean {
  return /^\s*(select|show|explain)\b/i.test(text);
}

/** Whether to retry a failed statement, given how it failed. */
export function shouldRetry(err: unknown, statement: string): boolean {
  const cls = classifyDbError(err);
  if (cls === "pre-send" || cls === "rolled-back") return true;
  if (cls === "ambiguous") return isReadOnlyStatement(statement);
  return false;
}

export interface RetryOptions {
  /** Total attempts, including the first. */
  attempts?: number;
  /** First backoff in ms; doubles each attempt, with jitter. */
  baseMs?: number;
  /** Largest single backoff in ms. */
  maxMs?: number;
  /** Called before each wait, for logging. */
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  /** Wait function; replaceable in tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run `fn`, retrying while `retryable(err)` says so. For operations that are
 * safe to repeat as a whole (an idempotent loop body, a whole transaction
 * function). The pool wrapper uses the same backoff through `runWithRetry`.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  retryable: (err: unknown) => boolean = (err) => classifyDbError(err) !== null,
  opts: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 5);
  const baseMs = opts.baseMs ?? 100;
  const maxMs = opts.maxMs ?? 2_000;
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !retryable(err)) throw err;
      const delay = Math.round(Math.min(maxMs, baseMs * 2 ** (attempt - 1)) * (0.5 + Math.random() * 0.5));
      opts.onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }
}
