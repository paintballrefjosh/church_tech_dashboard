import { Controller, Get, Inject, ServiceUnavailableException } from "@nestjs/common";
import { desc, eq, gte, like, sql, count } from "drizzle-orm";
import { ASSISTANT_STATE, PERMISSIONS, siteToday, type AssistantLastTest, type AssistantWatchState } from "@church/shared";
import { Public } from "../auth/public.decorator";
import { RequirePermissions } from "../auth/permissions.decorator";
import { DB, type Db } from "../db/db.module";
import { assistantAnswers, assistantUsageDaily, monitorChecks, monitors } from "../db/schema";
import { SettingsService } from "../settings/settings.service";
import { JobStateService } from "../cluster/job-state.service";
import { readAssistantConfig } from "../assistant/readiness";
import { getS3 } from "../attachments/s3.client";
import { describeS3, resolveS3Config } from "../attachments/s3.config";
import { engineFromVersion, engineLabel } from "../db/connection";

type ServiceStatus = "ok" | "degraded" | "down" | "unknown";

interface ServiceReport {
  /** Human-facing name shown on the monitoring page. */
  name: string;
  /** Stable id used for the icon / styling lookup on the client. */
  kind: string;
  status: ServiceStatus;
  latencyMs?: number;
  message?: string;
  /**
   * Free-form debug fields rendered as a key/value list in the detail modal.
   * Keep values short and human-readable — no nested objects.
   */
  details?: Record<string, string>;
}

const PROBE_TIMEOUT_MS = 2000;
/** Outer bound for the readiness read; the query itself is cancelled by the server at 2 s. */
const READY_TIMEOUT_MS = 3000;

@Controller()
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly jobState: JobStateService,
  ) {}

  @Public()
  @Get("healthz")
  liveness() {
    return { status: "ok", ts: new Date().toISOString() };
  }

  @Public()
  @Get("readyz")
  async readiness() {
    const checks: Record<string, string> = {};
    try {
      // A real read, with a server-side timeout. `SELECT 1` is answered by the SQL layer alone,
      // so a CockroachDB node whose cluster lost its majority would still pass it while every
      // actual query hangs; reading a table is what notices. The timeout also cancels the query,
      // so a stuck check cannot hold a pooled connection each time the load balancer asks.
      await withTimeout(
        this.db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL statement_timeout = 2000`);
          await tx.execute(sql`SELECT 1 FROM cluster_nodes LIMIT 1`);
        }),
        READY_TIMEOUT_MS,
        "database read timed out",
      );
      checks.db = "ok";
    } catch (err) {
      checks.db = `error: ${(err as Error).message}`;
    }
    const ok = Object.values(checks).every((v) => v === "ok");
    const body = { status: ok ? "ok" : "degraded", checks, ts: new Date().toISOString() };
    // A load balancer health-checks this (through the proxy's /healthz), so a node that
    // cannot reach the database must answer with an error status, not 200.
    if (!ok) throw new ServiceUnavailableException(body);
    return body;
  }

  /**
   * Service-by-service health for the /monitoring page banner. Probes each
   * runtime dependency in parallel with a short timeout so an unreachable
   * service can't stall the response. Gated on monitors:read:any so it lines
   * up with the rest of the monitoring surface.
   */
  @Get("health/services")
  @RequirePermissions(PERMISSIONS.MONITORS_READ_ANY)
  async services(): Promise<{ services: ServiceReport[]; ts: string }> {
    const services = await Promise.all([
      this.probeDb(),
      this.probeStorage(),
      this.probeSearch(),
      this.probeMonitorWorker(),
      this.probeAssistant().catch(() => null),
    ]);
    return { services: services.filter((s): s is ServiceReport => s !== null), ts: new Date().toISOString() };
  }

  /**
   * The assistant's card (docs/assistant.md section 12), only while it is switched on: degraded while the `assistant-watch`
   * job finds the provider failing or once the month's budget is used up (never "down": the platform itself is fine). From recorded state; it never calls the
   * provider. No key, address or spending figure: monitoring readers see this banner.
   */
  private async probeAssistant(): Promise<ServiceReport | null> {
    const c = await readAssistantConfig((k) => this.settings.get(k));
    if (!c.enabled) return null;
    const [watch, test] = await Promise.all([
      this.jobState.get<AssistantWatchState>(ASSISTANT_STATE.job, ASSISTANT_STATE.watch),
      this.jobState.get<AssistantLastTest>(ASSISTANT_STATE.job, ASSISTANT_STATE.lastTest),
    ]);
    const tz = String((await this.settings.get("site.timezone")) || "UTC");
    const month = siteToday(new Date(), tz).slice(0, 7);
    const [spent] = await this.db.select({ c: sql<string | number>`coalesce(sum(${assistantUsageDaily.cost}), 0)` }).from(assistantUsageDaily).where(like(assistantUsageDaily.day, `${month}-%`));
    const [recent] = await this.db
      .select({ n: count(), failed: sql<string | number>`sum(CASE WHEN ${assistantAnswers.outcome} = 'error' THEN 1 ELSE 0 END)` })
      .from(assistantAnswers)
      .where(gte(assistantAnswers.createdAt, new Date(Date.now() - 60 * 60_000)));
    const budgetUsed = c.monthlyBudget > 0 && Number(spent?.c ?? 0) >= c.monthlyBudget;
    const status: ServiceStatus = watch?.value.providerDown || budgetUsed ? "degraded" : "ok";
    return {
      name: "Assistant",
      kind: "assistant",
      status,
      message: watch?.value.providerDown ? "Its model has not been answering" : budgetUsed ? "This month's budget is used up" : undefined,
      details: {
        provider: c.provider === "anthropic" ? "Claude API" : "OpenAI-compatible server",
        model: c.model,
        "last test": test ? `${test.value.ok ? "passed" : "failed"} ${new Date(test.value.at).toLocaleString("en-GB", { timeZone: tz })}` : "never",
        "answers in the last hour": `${Number(recent?.n ?? 0)} (${Number(recent?.failed ?? 0)} failed)`,
      },
    };
  }

  private async probeDb(): Promise<ServiceReport> {
    const t0 = Date.now();
    const host = redactConnString(process.env.DATABASE_URL || process.env.COCKROACH_URL || "(env unset)");
    try {
      const res = await withTimeout(
        this.db.execute<{ version: string }>(sql`SELECT version() AS version`),
        PROBE_TIMEOUT_MS,
        "db probe timeout",
      );
      const latencyMs = Date.now() - t0;
      const version = String((res as { rows?: Array<{ version?: unknown }> }).rows?.[0]?.version ?? "");
      const engine = engineFromVersion(version);
      return {
        name: "Database",
        kind: engine,
        status: "ok",
        latencyMs,
        details: {
          engine: engineLabel(engine, version),
          host,
          "probe query": "SELECT version()",
          "probe latency": `${latencyMs} ms`,
        },
      };
    } catch (err) {
      return {
        name: "Database",
        kind: "database",
        status: "down",
        latencyMs: Date.now() - t0,
        message: (err as Error).message,
        details: {
          host,
          error: (err as Error).message,
        },
      };
    }
  }

  private async probeStorage(): Promise<ServiceReport> {
    const t0 = Date.now();
    let details: Record<string, string> = {};
    let kind = "garage";
    try {
      const cfg = resolveS3Config();
      details = describeS3(cfg);
      // The bundled store is Garage; anything else is "an S3 store", whatever it is.
      kind = cfg.endPoint === "garage" ? "garage" : "s3";
      const { client, bucket } = getS3();
      const exists = await withTimeout(client.bucketExists(bucket), PROBE_TIMEOUT_MS, "object store probe timeout");
      const latencyMs = Date.now() - t0;
      return {
        name: "Storage",
        kind,
        status: exists ? "ok" : "degraded",
        latencyMs,
        message: exists ? undefined : `bucket "${bucket}" does not exist (create it, or give the credentials permission to)`,
        details: { ...details, "bucket exists": String(exists), "probe latency": `${latencyMs} ms` },
      };
    } catch (err) {
      return {
        name: "Storage",
        kind,
        status: "down",
        latencyMs: Date.now() - t0,
        message: (err as Error).message,
        details: { ...details, error: (err as Error).message },
      };
    }
  }

  private async probeSearch(): Promise<ServiceReport> {
    const t0 = Date.now();
    const url = process.env.MEILI_URL;
    if (!url) {
      return {
        name: "Search",
        kind: "meilisearch",
        status: "unknown",
        message: "MEILI_URL not set",
        details: { "MEILI_URL env": "(unset)" },
      };
    }
    try {
      const res = await fetch(`${url.replace(/\/+$/, "")}/health`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      const latencyMs = Date.now() - t0;
      if (!res.ok) {
        return {
          name: "Search",
          kind: "meilisearch",
          status: "down",
          latencyMs,
          message: `http ${res.status}`,
          details: { url, "http status": String(res.status), "probe latency": `${latencyMs} ms` },
        };
      }
      return {
        name: "Search",
        kind: "meilisearch",
        status: "ok",
        latencyMs,
        details: { url, "http status": String(res.status), "probe latency": `${latencyMs} ms` },
      };
    } catch (err) {
      return {
        name: "Search",
        kind: "meilisearch",
        status: "down",
        latencyMs: Date.now() - t0,
        message: (err as Error).message,
        details: { url, error: (err as Error).message },
      };
    }
  }

  /**
   * Indirect liveness check: if the worker is running, monitor_checks gets a
   * fresh row every few seconds. We pull the latest ts and compare to now.
   *
   * `details` carries the diagnostics: configured poll interval, count of
   * enabled monitors (zero = nothing to poll, which makes "no recent ticks"
   * expected rather than a worker fault), recent check throughput, last
   * timestamp. Use these to disambiguate the "degraded" amber state.
   */
  private async probeMonitorWorker(): Promise<ServiceReport> {
    const pollIntervalMs = Number(process.env.MONITOR_POLL_MS ?? 5000) || 5000;
    const details: Record<string, string> = {
      "configured poll interval": `${pollIntervalMs} ms`,
    };
    try {
      const [latest] = await this.db
        .select({ ts: monitorChecks.ts })
        .from(monitorChecks)
        .orderBy(desc(monitorChecks.ts))
        .limit(1);
      const [enabledAgg] = await this.db
        .select({ n: count(), minIntervalSec: sql<number>`min(${monitors.intervalSec})` })
        .from(monitors)
        .where(eq(monitors.enabled, true));
      const enabledMonitors = Number(enabledAgg?.n ?? 0);
      // The freshest check row is only as recent as the most frequently polled
      // monitor's interval — a 60s monitor writes a row every 60s regardless of
      // how often the worker loops. Fall back to 60s if somehow unset.
      const minIntervalSec = Number(enabledAgg?.minIntervalSec ?? 0) || 60;
      details["enabled monitors"] = String(enabledMonitors);
      details["min monitor interval"] = `${minIntervalSec} s`;

      const sinceMs = new Date(Date.now() - 60_000);
      const [recentCount] = await this.db
        .select({ n: count() })
        .from(monitorChecks)
        .where(gte(monitorChecks.ts, sinceMs));
      details["checks in last 60s"] = String(Number(recentCount?.n ?? 0));

      if (!latest) {
        details["last tick"] = "(none recorded)";
        // Zero enabled monitors → worker has nothing to do; that's a quiet OK,
        // not a fault. Otherwise it's a real "we don't know yet" state.
        if (enabledMonitors === 0) {
          return {
            name: "Monitor worker",
            kind: "monitor",
            status: "ok",
            message: "idle — no monitors configured",
            details,
          };
        }
        return {
          name: "Monitor worker",
          kind: "monitor",
          status: "unknown",
          message: "no checks recorded yet",
          details,
        };
      }
      const ageMs = Date.now() - latest.ts.getTime();
      details["last tick"] = latest.ts.toISOString();
      details["age"] = `${Math.round(ageMs / 1000)} s`;

      // Same caveat as above: zero enabled monitors means a stale `last tick`
      // is expected, not an indication the worker is dead.
      if (enabledMonitors === 0) {
        return {
          name: "Monitor worker",
          kind: "monitor",
          status: "ok",
          message: "idle — no monitors configured",
          details,
        };
      }
      // Derive liveness thresholds from the minimum enabled interval rather
      // than fixed 30s/90s (which false-flagged healthy 60s monitors as
      // "degraded" for half of every cycle). Grace covers poll-loop
      // granularity + probe duration + scheduling jitter. ok: within one
      // interval + grace; degraded: missed roughly one cycle; down: ~two.
      const graceMs = pollIntervalMs + 15_000;
      const okMs = minIntervalSec * 1000 + graceMs;
      const degradedMs = minIntervalSec * 2000 + graceMs;
      details["healthy if under"] = `${Math.round(okMs / 1000)} s`;
      if (ageMs < okMs) {
        return { name: "Monitor worker", kind: "monitor", status: "ok", details };
      }
      if (ageMs < degradedMs) {
        return {
          name: "Monitor worker",
          kind: "monitor",
          status: "degraded",
          message: `last tick ${Math.round(ageMs / 1000)}s ago`,
          details,
        };
      }
      return {
        name: "Monitor worker",
        kind: "monitor",
        status: "down",
        message: `last tick ${Math.round(ageMs / 1000)}s ago`,
        details,
      };
    } catch (err) {
      return {
        name: "Monitor worker",
        kind: "monitor",
        status: "down",
        message: (err as Error).message,
        details: { ...details, error: (err as Error).message },
      };
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(msg)), ms)),
  ]);
}

/**
 * Strip the password out of a DB URL before surfacing it in the debug modal.
 * "postgres://user:pass@host:5432/db" → "postgres://user@host:5432/db".
 */
function redactConnString(s: string): string {
  return s.replace(/(:\/\/[^:/@]+):[^@]+@/, "$1@");
}
