import { isIP } from "node:net";
import * as tls from "node:tls";
import { Client, Pool, type ClientConfig, type PoolConfig } from "pg";
import { classifyDbError, shouldRetry, withRetry } from "./retry";

/**
 * Make a client check the server certificate against the host it was asked to
 * connect to even when that host is an IP address.
 *
 * Without this, a TLS connection to an IP checks the certificate against the name
 * "localhost" (Node's fallback when pg hands it an already-connected socket), so
 * `sslmode=verify-full` would accept any certificate from the trusted CA that
 * names localhost, whatever machine answered. With a hostname in the URL pg does
 * the right thing already; this only changes the IP case.
 */
function applyHostCheck(client: Client): void {
  const params = (client as unknown as { connectionParameters?: { host?: string; ssl?: unknown } }).connectionParameters;
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

export class HostCheckingClient extends Client {
  constructor(config?: ConstructorParameters<typeof Client>[0]) {
    super(config);
    applyHostCheck(this);
  }
}

type ClientCtor = new (config?: ClientConfig) => Client;
type ClientConnect = (...args: unknown[]) => unknown;

// ---------------------------------------------------------------------------------------------
// Several database hosts in one URL
// ---------------------------------------------------------------------------------------------

/** One host of a connection URL's host list. */
export interface DbSeed {
  host: string;
  port: string;
}

/** The pieces of a connection URL whose authority may name several hosts. */
export interface ParsedDbUrl {
  scheme: string;
  userinfo: string;
  seeds: DbSeed[];
  rest: string;
}

/**
 * Split `postgresql://user:pw@h1:5433,h2:5433,h3:5433/db?x=y` into its parts (the host list is the
 * same syntax libpq and psql accept). A URL with one host parses the same way, with one seed.
 * Returns null when it is not a postgres URL.
 */
export function parseDbUrl(url: string): ParsedDbUrl | null {
  const m = /^(postgres(?:ql)?:\/\/)([^/?#]*@)?([^/?#]+)([/?#].*)?$/.exec(url);
  if (!m) return null;
  const seeds: DbSeed[] = [];
  for (const entry of m[3]!.split(",")) {
    const h = /^(\[[^\]]+\]|[^:]+)(?::(\d*))?$/.exec(entry.trim());
    if (!h) return null;
    seeds.push({ host: h[1]!, port: h[2] ?? "" });
  }
  return { scheme: m[1]!, userinfo: m[2] ?? "", seeds, rest: m[4] ?? "" };
}

/** The URL with just one of its hosts. */
export function dbUrlWithSeed(parsed: ParsedDbUrl, seed: DbSeed): string {
  return `${parsed.scheme}${parsed.userinfo}${seed.host}${seed.port ? `:${seed.port}` : ""}${parsed.rest}`;
}

/**
 * Which of a URL's hosts the next new connection goes to, and which are failing.
 *
 * A new connection goes to the host with the fewest connections open from this process, so the
 * load spreads over the nodes and, after a node comes back, the next connections move onto it. A
 * host a connection attempt just failed on is left out for a cooldown (5 s, doubling on each
 * further failure in a row up to 60 s), so a dead node costs one failed attempt, not one per
 * request. If every host is cooling down the one that comes back soonest is tried anyway.
 *
 * Nodes are the ones named in the URL: unlike the YugabyteDB smart driver, nothing is discovered.
 * (The smart driver was tried and was left out: in tests against a real three node cluster its
 * failover hung for good in three of five runs, see docs/multi-node.md.)
 */
export class HostSet {
  private readonly open = new Map<string, number>();
  private readonly downUntil = new Map<string, number>();
  private readonly failures = new Map<string, number>();

  constructor(
    readonly parsed: ParsedDbUrl,
    private readonly log: (message: string) => void = () => undefined,
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random,
  ) {}

  get size(): number {
    return this.parsed.seeds.length;
  }

  private static key(seed: DbSeed): string {
    return `${seed.host}:${seed.port}`;
  }

  /** The host for the next new connection. */
  pick(): DbSeed {
    const t = this.now();
    const all = this.parsed.seeds;
    let candidates = all.filter((s) => (this.downUntil.get(HostSet.key(s)) ?? 0) <= t);
    if (candidates.length === 0) {
      const soonest = Math.min(...all.map((s) => this.downUntil.get(HostSet.key(s)) ?? 0));
      candidates = all.filter((s) => (this.downUntil.get(HostSet.key(s)) ?? 0) === soonest);
    }
    const fewest = Math.min(...candidates.map((s) => this.open.get(HostSet.key(s)) ?? 0));
    const best = candidates.filter((s) => (this.open.get(HostSet.key(s)) ?? 0) === fewest);
    return best[Math.floor(this.random() * best.length)]!;
  }

  /** A connection to this host is being opened (counted until it closes or fails). */
  opening(seed: DbSeed): void {
    const k = HostSet.key(seed);
    this.open.set(k, (this.open.get(k) ?? 0) + 1);
  }

  /** A connection to this host closed, or never opened. */
  closed(seed: DbSeed): void {
    const k = HostSet.key(seed);
    this.open.set(k, Math.max(0, (this.open.get(k) ?? 0) - 1));
  }

  /** A connection to this host was established: it is healthy again. */
  succeeded(seed: DbSeed): void {
    const k = HostSet.key(seed);
    if (this.failures.has(k) && this.size > 1) this.log(`[db] ${k} is answering again`);
    this.failures.delete(k);
    this.downUntil.delete(k);
  }

  /** A connection attempt to this host failed: leave it out for a while. */
  failed(seed: DbSeed): void {
    const k = HostSet.key(seed);
    const n = (this.failures.get(k) ?? 0) + 1;
    this.failures.set(k, n);
    const cooldownMs = Math.min(5_000 * 2 ** (n - 1), 60_000);
    this.downUntil.set(k, this.now() + cooldownMs);
    if (n === 1) this.log(`[db] could not connect to ${k}; using the other hosts of DATABASE_URL for ${cooldownMs / 1000}s`);
  }
}

/**
 * A client that chooses its host from a HostSet when it is created, and reports back how the
 * connection went. A failed connection attempt is an error like any other "never reached the
 * database" failure, so the retry rules (retry.ts) try again, and the next client picks another host.
 */
function multiHostClient(Base: ClientCtor, hosts: HostSet): ClientCtor {
  return class MultiHostClient extends Base {
    constructor(config?: ClientConfig) {
      const seed = hosts.pick();
      super({ ...config, connectionString: dbUrlWithSeed(hosts.parsed, seed) });
      applyHostCheck(this);
      hosts.opening(seed);
      let counted = true;
      const release = () => {
        if (counted) {
          counted = false;
          hosts.closed(seed);
        }
      };
      this.once("end", release);
      const original = (this as unknown as { connect: ClientConnect }).connect.bind(this);
      const report = (err?: Error) => {
        if (err) {
          hosts.failed(seed);
          release();
        } else {
          hosts.succeeded(seed);
        }
      };
      (this as unknown as { connect: ClientConnect }).connect = (...args: unknown[]) => {
        const callback = args[0];
        if (typeof callback === "function") {
          return original((err?: Error) => {
            report(err);
            (callback as (e?: Error) => void)(err);
          });
        }
        return (original() as Promise<void>).then(
          () => report(),
          (err: unknown) => {
            report(err as Error);
            throw err;
          },
        );
      };
    }
  };
}

export interface CreatePoolOptions {
  /** Names this process's connections in the database (`application_name`), e.g. "api". */
  name: string;
  /** Maximum connections. Default 10. */
  max?: number;
  /** Override the URL from the environment. */
  url?: string;
  /**
   * Give up on a statement that has had no answer for this long (ms), drop that connection and let
   * the retry rules try another. Without it, a database host that vanishes without closing its
   * connections (power loss, a cable pulled, a firewall dropping packets) leaves every statement
   * on them waiting for TCP to give up, which takes many minutes. Default 60000, or
   * `DB_QUERY_TIMEOUT_MS` when set; 0 turns it off (migrations, which may run long statements).
   */
  queryTimeoutMs?: number;
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
  const url = opts.url ?? databaseUrlFromEnv();
  const config: PoolConfig = {
    connectionString: url,
    max: opts.max ?? 10,
    application_name: `church-${opts.name}`,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    maxLifetimeSeconds: 30 * 60,
    Client: HostCheckingClient as unknown as PoolConfig["Client"],
  };
  const envTimeout = Number(process.env.DB_QUERY_TIMEOUT_MS);
  const queryTimeout = opts.queryTimeoutMs ?? (Number.isFinite(envTimeout) && process.env.DB_QUERY_TIMEOUT_MS ? envTimeout : 60_000);
  if (queryTimeout > 0) config.query_timeout = queryTimeout;
  const parsed = parseDbUrl(url);
  if (parsed && parsed.seeds.length > 1) {
    config.Client = multiHostClient(HostCheckingClient as unknown as ClientCtor, new HostSet(parsed, (m) => log(m))) as unknown as PoolConfig["Client"];
  }
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

  // Checking out a connection (a transaction starts with it) fails before anything was sent when no
  // host answers: safe to try again, and the next attempt goes to another host.
  const originalConnect = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
  (pool as unknown as { connect: (...args: unknown[]) => unknown }).connect = (...args: unknown[]) => {
    if (typeof args[0] === "function") return originalConnect(...args);
    return withRetry(
      () => originalConnect() as Promise<unknown>,
      (err) => classifyDbError(err) === "pre-send",
      {
        attempts: opts.retryAttempts ?? 5,
        onRetry: (err, attempt, delay) =>
          logThrottled("retry", `[db:${opts.name}] retrying after ${(err as Error).message} (attempt ${attempt}, in ${delay}ms)`),
      },
    );
  };

  return pool;
}
