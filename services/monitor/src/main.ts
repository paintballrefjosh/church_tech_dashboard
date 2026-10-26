/* eslint-disable no-console */
import { and, desc, eq, gt, gte, inArray, isNull, sql } from "drizzle-orm";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { acquireLease, restoreInProgress } from "@church/shared/db";
import {
  ALERT_KEYS,
  MAINTENANCE_MODE_KEY,
  MAINTENANCE_UNTIL_KEY,
  describeMinutes,
  flapConfig,
  flapSettled,
  isFlapping,
  maintenanceState,
  monitorAlertsOff,
  monitorScheduleActive,
  parseMonitorSchedule,
  type FlapConfig,
} from "@church/shared";
import { db, pool } from "./db";
import { claimDueMonitors, releaseMonitorClaim } from "./claim";
import {
  monitors,
  monitorChecks,
  monitorIncidents,
  settings,
  activityEvents,
  alertOutbox,
} from "./schema";
import { probeHttp, probeTcp, probeIcmp, probeDns, probeTls, type ProbeResult } from "./probes";
import { probeHls, probeHyperdeck, probePjlink, probeShure, probeObs, probeAtem } from "./av-probes";

const POLL_MS = parseInt(process.env.MONITOR_POLL_MS ?? "5000", 10);
const PRUNE_KEEP_DAYS = parseInt(process.env.MONITOR_PRUNE_DAYS ?? "30", 10);
const PRUNE_EVERY_MS = parseInt(process.env.MONITOR_PRUNE_MS ?? `${60 * 60_000}`, 10);
const PRUNE_BATCH = 5000;
const PRUNE_MAX_BATCHES = 200;

// How long a worker holds a monitor it has taken. Longer than any probe (their own
// timeouts are well under this), so a monitor is never probed twice at once; if a
// worker dies mid-probe the check is late by at most this long.
const CLAIM_SEC = parseInt(process.env.MONITOR_CLAIM_SEC ?? "60", 10);
// Monitors taken per tick. Bounded so one worker does not take the whole fleet.
const CLAIM_BATCH = parseInt(process.env.MONITOR_CLAIM_BATCH ?? "50", 10);
// The app node this worker belongs to (the same NODE_ID the api uses), recorded on every check so the
// dashboard can show which node probed what. "main" is the single-node default.
const NODE_ID = process.env.NODE_ID || "main";
// Identifies this worker among the others sharing the database.
const WORKER_ID = `monitor/${hostname()}/${randomUUID().slice(0, 8)}`;

// In-flight set so a slow probe doesn't get re-launched on the next tick.
// (Claims already keep other workers off a monitor; this is the local guard.)
const inFlight = new Set<string>();

async function runProbe(kind: string, target: string, options: Record<string, unknown>): Promise<ProbeResult> {
  switch (kind) {
    case "http":
      return probeHttp({ target, options });
    case "tcp":
      return probeTcp({ target, options });
    case "icmp":
      return probeIcmp({ target, options });
    case "dns":
      return probeDns({ target, options });
    case "tls":
      return probeTls({ target, options });
    case "hls":
      return probeHls({ target, options });
    case "hyperdeck":
      return probeHyperdeck({ target, options });
    case "pjlink":
      return probePjlink({ target, options });
    case "shure":
      return probeShure({ target, options });
    case "obs":
      return probeObs({ target, options });
    case "atem":
      return probeAtem({ target, options });
    default:
      return { ok: false, latencyMs: 0, info: `unknown kind '${kind}'` };
  }
}

/** What a check outside the monitor's hours records. Closing an incident with it sends no "is back up" notice. */
const OUTSIDE_HOURS = "outside its hours (not checked)";

/** The site's time zone for schedules, read at most once a minute. */
let zoneCache: { at: number; tz: string } | null = null;
async function siteZone(): Promise<string> {
  if (zoneCache && Date.now() - zoneCache.at < 60_000) return zoneCache.tz;
  let tz = "UTC";
  try {
    const [row] = await db.select().from(settings).where(eq(settings.key, "site.timezone")).limit(1);
    if (typeof row?.value === "string" && row.value) tz = row.value;
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
  } catch {
    tz = "UTC";
  }
  zoneCache = { at: Date.now(), tz };
  return tz;
}

/** Whether a monitor is due a real check now (`options.schedule`); a schedule that cannot be read is ignored (always). */
async function inSchedule(options: Record<string, unknown>): Promise<boolean> {
  const text = options.schedule;
  if (typeof text !== "string" || !text.trim()) return true;
  try {
    return monitorScheduleActive(parseMonitorSchedule(text), new Date(), await siteZone());
  } catch {
    return true;
  }
}

/** Mirrors SettingsService.get for the two keys this worker cares about; the rule is shared with the API. */
async function maintenanceModeOn(): Promise<boolean> {
  const rows = await db.select().from(settings).where(inArray(settings.key, [MAINTENANCE_MODE_KEY, MAINTENANCE_UNTIL_KEY]));
  const value = (key: string) => rows.find((r) => r.key === key)?.value;
  return maintenanceState(value(MAINTENANCE_MODE_KEY), value(MAINTENANCE_UNTIL_KEY)).active;
}

/** The two flap settings (shared rule: alert-rules.ts). A read that fails turns the rule off for that check, never the alert. */
async function readFlapConfig(): Promise<FlapConfig> {
  const rows = await db.select().from(settings).where(inArray(settings.key, [ALERT_KEYS.flapIncidents, ALERT_KEYS.flapWindowMin]));
  const value = (key: string) => rows.find((r) => r.key === key)?.value;
  return flapConfig(value(ALERT_KEYS.flapIncidents), value(ALERT_KEYS.flapWindowMin));
}

async function activity(monitor: typeof monitors.$inferSelect, action: string, title: string, summary: string, ts: Date) {
  // Activity feed: actor is null because the worker isn't acting on behalf of a user. The page renders "system".
  await db
    .insert(activityEvents)
    .values({ actorUserId: null, actorEmail: null, action, resourceType: "monitor", resourceId: monitor.id, title, summary, link: `/monitoring/${monitor.id}`, ts })
    .catch(() => { /* best-effort */ });
}

async function notifyAll(kind: string, title: string, body: string, link: string) {
  // Silences notifications during maintenance mode, same as the in-app infra
  // alert fan-out (see CLAUDE.md ## Maintenance mode) — incidents are still
  // recorded above; only the notification is paused.
  if (await maintenanceModeOn().catch(() => false)) return;
  // Queued for the API's `alert-dispatch` job, which tells the monitoring recipients through NotificationsService (bell,
  // email and push by each person's own choices, quiet hours, urgent kinds) and the alert channels. Until 2026-10-25 this
  // inserted bell rows itself, so a service going down never sent an email or a push.
  await db.insert(alertOutbox).values({ kind, title, body, link, fanout: true });
}

/**
 * Apply one probe result. Updates denormalised state on the monitor row,
 * appends a check, and opens/closes an incident when thresholds cross.
 */
async function applyResult(
  monitor: typeof monitors.$inferSelect,
  result: ProbeResult,
): Promise<void> {
  const now = new Date();
  await db.insert(monitorChecks).values({
    monitorId: monitor.id,
    ok: result.ok,
    latencyMs: result.latencyMs,
    info: result.info,
    nodeId: NODE_ID,
    ts: now,
  });

  const nextOks = result.ok ? monitor.consecutiveOks + 1 : 0;
  const nextFails = result.ok ? 0 : monitor.consecutiveFails + 1;

  let nextStatus: "up" | "down" | "unknown" = monitor.status as "up" | "down" | "unknown";
  let crossedDown = false;
  let crossedUp = false;
  if (!result.ok && nextFails >= monitor.failThreshold && nextStatus !== "down") {
    nextStatus = "down";
    crossedDown = true;
  } else if (result.ok && nextOks >= monitor.recoverThreshold && nextStatus !== "up") {
    nextStatus = "up";
    crossedUp = monitor.status === "down"; // only notify if we were down
  }

  await db
    .update(monitors)
    .set({
      status: nextStatus,
      lastCheckedAt: now,
      lastCheckedBy: NODE_ID,
      lastLatencyMs: result.latencyMs,
      consecutiveFails: nextFails,
      consecutiveOks: nextOks,
      updatedAt: now,
      // The check is recorded: give the monitor back.
      claimedUntil: null,
    })
    .where(eq(monitors.id, monitor.id));

  // A monitor that is "flapping" (alert-rules.ts) has its individual down and up notices held back: one notice says it is
  // unstable, one more says it has settled. Incidents are still recorded in full.
  let flappingNow = monitor.flappingSince !== null;
  let announcedNow = false;
  const link = `/monitoring/${monitor.id}`;
  // A monitor with alerts off (`options.alerts: false`) records everything below but tells nobody.
  const notify = monitorAlertsOff(monitor.options as Record<string, unknown> | null) ? async () => undefined : notifyAll;

  if (crossedDown) {
    const [opened] = await db
      .insert(monitorIncidents)
      .values({
        monitorId: monitor.id,
        startedAt: now,
        reason: result.info,
      })
      .returning();
    if (opened) {
      let flapNotice: { opens: number; config: FlapConfig } | null = null;
      if (!flappingNow) {
        try {
          const config = await readFlapConfig();
          if (config.incidents > 0) {
            const since = new Date(now.getTime() - config.windowMin * 60_000);
            const [row] = await db
              .select({ n: sql<string | number>`count(*)` })
              .from(monitorIncidents)
              .where(and(eq(monitorIncidents.monitorId, monitor.id), gte(monitorIncidents.startedAt, since)));
            const opens = Number(row?.n ?? 0);
            if (isFlapping(opens, config)) flapNotice = { opens, config };
          }
        } catch (err) {
          console.error(`[monitor] ${monitor.name} flap check failed`, (err as Error).message);
        }
      }
      if (flapNotice) {
        await db.update(monitors).set({ flappingSince: now }).where(eq(monitors.id, monitor.id));
        flappingNow = true;
        announcedNow = true;
        const title = `${monitor.name} is unstable`;
        const body = `It went down ${flapNotice.opens} times in ${describeMinutes(flapNotice.config.windowMin * 60_000)}. Down and up notices for it are paused until it has stayed the same for that long.`;
        await notify("monitor.flapping", title, body, link);
        await activity(monitor, "monitor.flapping", title, body, now);
      } else if (!flappingNow) {
        const summary = `${monitor.kind.toUpperCase()} check failed: ${result.info}`;
        await notify("monitor.incident.opened", `${monitor.name} is down`, summary, link);
        await activity(monitor, "monitor.incident.opened", `${monitor.name} is down`, summary, now);
      }
    }
  } else if (crossedUp) {
    // Resolve the most-recent open incident for this monitor.
    const [open] = await db
      .select()
      .from(monitorIncidents)
      .where(
        and(eq(monitorIncidents.monitorId, monitor.id), isNull(monitorIncidents.resolvedAt)),
      )
      .limit(1);
    if (open) {
      await db
        .update(monitorIncidents)
        .set({ resolvedAt: now })
        .where(eq(monitorIncidents.id, open.id));
      // Closed because its hours ended, not because it came back: nothing to announce.
      if (!flappingNow && result.info !== OUTSIDE_HOURS) {
        const downSecs = Math.round((now.getTime() - new Date(open.startedAt).getTime()) / 1000);
        const summary = `${monitor.kind.toUpperCase()} recovered after ${downSecs}s`;
        await notify("monitor.incident.resolved", `${monitor.name} is back up`, summary, link);
        await activity(monitor, "monitor.incident.resolved", `${monitor.name} is back up`, summary, now);
      }
    }
  }

  // Settled: it has stayed in one state for the whole window (judged after the writes above, so a change in this very
  // check counts). Then the notices resume, and the person is told which state it settled in.
  if (flappingNow && !announcedNow) {
    try {
      const config = await readFlapConfig();
      const [latest] = await db
        .select({ startedAt: monitorIncidents.startedAt, resolvedAt: monitorIncidents.resolvedAt })
        .from(monitorIncidents)
        .where(eq(monitorIncidents.monitorId, monitor.id))
        .orderBy(desc(monitorIncidents.startedAt))
        .limit(1);
      const lastChange = latest ? (latest.resolvedAt ?? latest.startedAt) : (monitor.flappingSince ?? now);
      if (flapSettled(lastChange, now, config)) {
        // Clear only if still set: another node's worker may have settled it a moment ago.
        const cleared = await db
          .update(monitors)
          .set({ flappingSince: null })
          .where(and(eq(monitors.id, monitor.id), sql`${monitors.flappingSince} is not null`))
          .returning({ id: monitors.id });
        if (cleared.length > 0) {
          if (nextStatus === "down") {
            const summary = `${monitor.kind.toUpperCase()} check keeps failing: ${result.info}`;
            await notify("monitor.incident.opened", `${monitor.name} is down`, summary, link);
            await activity(monitor, "monitor.incident.opened", `${monitor.name} is down`, summary, now);
          } else if (nextStatus === "up") {
            const summary = `It has stayed up for ${describeMinutes(config.windowMin * 60_000)}. Down and up notices are back on.`;
            await notify("monitor.flapping", `${monitor.name} is stable again`, summary, link);
            await activity(monitor, "monitor.flapping", `${monitor.name} is stable again`, summary, now);
          }
        }
      }
    } catch (err) {
      console.error(`[monitor] ${monitor.name} flap settle check failed`, (err as Error).message);
    }
  }
}

async function tick() {
  // A backup restore is rewriting the database: stand back until it is done, so nothing this
  // worker writes (check results, incidents) can collide with it. Checks resume on the next tick.
  try {
    if (await restoreInProgress(pool)) return;
  } catch {
    // The database cannot be asked; the claim below will say the same, and is handled.
  }
  let due: Array<typeof monitors.$inferSelect>;
  try {
    // Take what is due. With several nodes each running a worker, only one of
    // them gets any given monitor.
    const ids = await claimDueMonitors(pool, CLAIM_BATCH, CLAIM_SEC);
    if (ids.length === 0) return;
    due = await db.select().from(monitors).where(inArray(monitors.id, ids));
  } catch (err) {
    console.error("[monitor] select failed", (err as Error).message);
    return;
  }
  for (const m of due) {
    if (inFlight.has(m.id)) continue;
    inFlight.add(m.id);
    void (async () => {
      try {
        const options = (m.options as Record<string, unknown>) ?? {};
        // Outside its hours (options.schedule) a monitor is not probed: a healthy "not checked" result is recorded, so an
        // incident left open when the service ended closes and nobody is paged about a stream that is meant to be off.
        const result = (await inSchedule(options))
          ? await runProbe(m.kind, m.target, options)
          : { ok: true, latencyMs: 0, info: OUTSIDE_HOURS };
        await applyResult(m, result);
      } catch (err) {
        console.error(`[monitor] ${m.name} (${m.id}) probe error`, (err as Error).message);
        // The check was not recorded: hand the monitor back so it is retried at its next interval.
        await releaseMonitorClaim(pool, m.id).catch(() => { /* the claim lapses on its own */ });
      } finally {
        inFlight.delete(m.id);
      }
    })();
  }
}

async function prune() {
  try {
    // Every node runs a worker; one pruning per period is enough. The lease lasts
    // most of the period and is not released, so the others skip until it lapses
    // (or this worker dies).
    const ttlSec = Math.max(60, Math.floor((PRUNE_EVERY_MS / 1000) * 0.9));
    if (!(await acquireLease(pool, "job:monitor-prune", WORKER_ID, ttlSec))) return;
    const cutoff = new Date(Date.now() - PRUNE_KEEP_DAYS * 86_400_000);
    // In batches, by primary key through a LIMITed subquery (portable; `DELETE ... LIMIT` is CockroachDB-only): one
    // unbounded DELETE after a long outage, or after the retention was lowered, held a huge transaction against the
    // probes' own inserts. A pass stops at PRUNE_MAX_BATCHES; the next hour carries on.
    let total = 0;
    for (let i = 0; i < PRUNE_MAX_BATCHES; i++) {
      const r = await db.execute(sql`
        DELETE FROM ${monitorChecks}
        WHERE ${monitorChecks.id} IN (
          SELECT ${monitorChecks.id} FROM ${monitorChecks} WHERE ${monitorChecks.ts} < ${cutoff} LIMIT ${PRUNE_BATCH}
        )`);
      const n = (r as { rowCount?: number | null }).rowCount ?? 0;
      total += n;
      if (n < PRUNE_BATCH) break;
    }
    if (total > 0) console.log(`[monitor] pruned ${total} checks older than ${PRUNE_KEEP_DAYS}d`);
  } catch (err) {
    console.error("[monitor] prune failed", (err as Error).message);
  }
}

async function main() {
  console.log(`[monitor] starting on node ${NODE_ID}; poll=${POLL_MS}ms prune-keep=${PRUNE_KEEP_DAYS}d`);
  setInterval(() => void tick(), POLL_MS);
  setInterval(() => void prune(), PRUNE_EVERY_MS);
  // Kick a first tick immediately so a freshly-started worker doesn't sit
  // idle until the first interval elapses.
  await tick();

  // graceful shutdown
  const shutdown = async (sig: string) => {
    console.log(`[monitor] received ${sig}, shutting down`);
    // Hand back the monitors still being probed, so another worker (or this one,
    // restarted) takes them at once instead of after the claim lapses.
    await Promise.all([...inFlight].map((id) => releaseMonitorClaim(pool, id).catch(() => undefined)));
    try { await pool.end(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[monitor] fatal", err);
  process.exit(1);
});

// 'gt' is imported above but only used indirectly through other selectors —
// keep it referenced so the bundler doesn't drop it if the query shape
// changes later.
void gt;
