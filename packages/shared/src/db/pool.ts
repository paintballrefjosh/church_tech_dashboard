import { isIP } from "node:net";
import * as tls from "node:tls";
import { Client, Pool, type PoolConfig } from "pg";
import { shouldRetry, withRetry } from "./retry";

/**
 * pg client that checks the server certificate against the host it was asked to
 * connect to even when that host is an IP address.
 *
 * Without this, a TLS connection to an IP checks the certificate against the name
 * "localhost" (Node's fallback when pg hands it an already-connected socket), so
 * `sslmode=verify-full` would accept any certificate from the trusted CA that
 * names localhost, whatever machine answered. With a hostname in the URL pg does
 * the right thing already; this only changes the IP case.
 */
export class HostCheckingClient extends Client {
  constructor(config?: ConstructorParameters<typeof Client>[0]) {
    super(config);
    const params = (this as unknown as { connectionParameters?: { host?: string; ssl?: unknown } }).connectionParameters;
    const ssl = params?.ssl;
    const host = params?.host;
    if (ssl && typeof ssl === "object" && host && isIP(host) !== 0) {
      const opts = ssl as tls.ConnectionOptions;
      // rejectUnauthorized:false is `sslmode=no-verify`: the operator chose not to verify.
      if (opts.rejectUnauthorized !== false && !opts.checkServerIdentity) {
        opts.checkServerIdentity = (_name, cert) => tls.checkServerIdentity(host, cert);
      }
    }
  }
}

export interface CreatePoolOptions {
  /** Names this process's connections in the database (`application_name`), e.g. "api". */
  name: string;
  /** Maximum connections. Default 10. */
  max?: number;
  /** Override the URL from the environment. */
  url?: string;
  /** Total attempts for a retryable statement, including the first. Default 5. */
  retryAttempts?: number;
  /** Where to report trouble. Default: console.warn. */
  log?: (message: string) => void;
}

/** The connection string, from `DATABASE_URL` (or the old `COCKROACH_URL`). */
export function databaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_URL || env.COCKROACH_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return url;
}

/**
 * The one way every process (API, web, monitor worker, scripts) opens its
 * database pool:
 *
 *  - **An `error` handler.** pg emits `error` on the pool when an idle
 *    connection breaks (a database node dying does this). With no listener Node
 *    treats it as an uncaught exception and the process exits.
 *  - **Timeouts and keep-alive**, so a half-open connection to a dead node is
 *    noticed instead of hanging, and a connection is not kept for ever
 *    (`maxLifetimeSeconds`), so connections move to the live nodes behind a load
 *    balancer after a failover.
 *  - **Automatic retry of statements that are safe to repeat** (see retry.ts):
 *    anything that never reached the database or was rolled back, and plain
 *    SELECTs whose connection broke. Writes whose outcome is unknown are never
 *    retried.
 *  - **TLS** from the URL: pg understands `sslmode`, `sslrootcert`, `sslcert` and
 *    `sslkey` (e.g. `?sslmode=verify-full&sslrootcert=/certs/ca.crt`). pg 8 treats
 *    `require` and `verify-ca` as `verify-full`, so use `verify-full`. Name the
 *    server by host name, not IP, so the certificate can be matched to it.
 */
export function createPool(opts: CreatePoolOptions): Pool {
  const log = opts.log ?? ((m: string) => console.warn(m));
  const config: PoolConfig = {
    connectionString: opts.url ?? databaseUrlFromEnv(),
    max: opts.max ?? 10,
    application_name: `church-${opts.name}`,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    maxLifetimeSeconds: 30 * 60,
    Client: HostCheckingClient as unknown as PoolConfig["Client"],
  };
  const pool = new Pool(config);

  // At most one line per interval, so an outage does not flood the log.
  const lastLogged = new Map<string, number>();
  const logThrottled = (key: string, message: string) => {
    const now = Date.now();
    if (now - (lastLogged.get(key) ?? 0) < 10_000) return;
    lastLogged.set(key, now);
    log(message);
  };

  pool.on("error", (err) => {
    logThrottled("pool-error", `[db:${opts.name}] idle connection error (the pool will replace it): ${err.message}`);
  });

  // Wrap pool.query. Callback-style calls and submittables are left alone.
  const original = pool.query.bind(pool) as (...args: unknown[]) => unknown;
  (pool as unknown as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => {
    const last = args[args.length - 1];
    const first = args[0] as { text?: string; submit?: unknown } | string | undefined;
    if (typeof last === "function" || (typeof first === "object" && first !== null && typeof first.submit === "function")) {
      return original(...args);
    }
    const statement = typeof first === "string" ? first : (first?.text ?? "");
    return withRetry(
      () => original(...args) as Promise<unknown>,
      (err) => shouldRetry(err, statement),
      {
        attempts: opts.retryAttempts ?? 5,
        onRetry: (err, attempt, delay) =>
          logThrottled("retry", `[db:${opts.name}] retrying after ${(err as Error).message} (attempt ${attempt}, in ${delay}ms)`),
      },
    );
  };

  return pool;
}
