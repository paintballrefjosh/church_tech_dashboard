/* eslint-disable no-console */
import { and, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { acquireLease, restoreInProgress } from "@church/shared/db";
import { db, pool } from "./db";
import { claimDueMonitors, releaseMonitorClaim } from "./claim";
import {
  monitors,
  monitorChecks,
  monitorIncidents,
  notifications,
  users,
  groups,
  groupMemberships,
  groupModuleAccess,
  settings,
  activityEvents,
} from "./schema";
import { probeHttp, probeTcp, probeIcmp, probeDns, type ProbeResult } from "./probes";

const POLL_MS = parseInt(process.env.MONITOR_POLL_MS ?? "5000", 10);
const PRUNE_KEEP_DAYS = parseInt(process.env.MONITOR_PRUNE_DAYS ?? "30", 10);
const PRUNE_EVERY_MS = parseInt(process.env.MONITOR_PRUNE_MS ?? `${60 * 60_000}`, 10);

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
    default:
      return { ok: false, latencyMs: 0, info: `unknown kind '${kind}'` };
  }
}

/**
 * Recipients for monitor notifications: every active, non-deleted user who
 * holds the `monitoring` module (any tier — reads only need `user` tier) via
 * group_module_access, or is in the admin group (which implicitly gets
 * everything — see CLAUDE.md ## Access control). Computed per-event so group
 * changes take effect without restarting the worker.
 *
 * This used to join through the legacy user_roles/roles/role_permissions
 * tables (pre migration 0022/0024) which are dead — always empty — so this
 * worker's notifications were a silent no-op for every recipient. Fixed
 * 2026-09-18 to mirror apps/api/src/infra/infra.service.ts's
 * monitoringRecipientIds().
 */
async function notificationRecipients(): Promise<{ id: string; email: string | null; muted: string[] }[]> {
  const rows = await db
    .selectDistinct({ id: users.id, email: users.email, muted: users.mutedNotificationKinds })
    .from(users)
    .innerJoin(groupMemberships, eq(groupMemberships.userId, users.id))
    .innerJoin(groups, eq(groups.id, groupMemberships.groupId))
    .leftJoin(
      groupModuleAccess,
      and(eq(groupModuleAccess.groupId, groups.id), eq(groupModuleAccess.moduleKey, "monitoring")),
    )
    .where(
      and(
        eq(users.isActive, true),
        isNull(users.deletedAt),
        or(eq(groups.name, "admin"), sql`${groupModuleAccess.groupId} is not null`),
      ),
    );
  return rows.map((r) => ({ id: r.id, email: r.email, muted: r.muted ?? [] }));
}

/** Mirrors SettingsService.get for the one key this worker cares about. */
async function maintenanceModeOn(): Promise<boolean> {
  const [row] = await db.select().from(settings).where(eq(settings.key, "monitoring.maintenance_mode")).limit(1);
  return row?.value === true;
}

async function notifyAll(kind: string, title: string, body: string, link: string) {
  // Silences notifications during maintenance mode, same as the in-app infra
  // alert fan-out (see CLAUDE.md ## Maintenance mode) — incidents are still
  // recorded above; only the notification is paused.
  if (await maintenanceModeOn().catch(() => false)) return;
  const recipients = await notificationRecipients();
  if (recipients.length === 0) return;
  const rows = recipients
    .filter((r) => !(r.muted ?? []).includes(kind))
    .map((r) => ({
      recipientUserId: r.id,
      kind,
      title,
      body,
      link,
      createdAt: new Date(),
    }));
  if (rows.length === 0) return;
  await db.insert(notifications).values(rows);
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
      await notifyAll(
        "monitor.incident.opened",
        `${monitor.name} is down`,
        `${monitor.kind.toUpperCase()} check failed: ${result.info}`,
        `/monitoring/${monitor.id}`,
      );
      // Activity feed: actor is null because the worker isn't acting on
      // behalf of a user. The page renders "system" for those.
      await db.insert(activityEvents).values({
        actorUserId: null,
        actorEmail: null,
        action: "monitor.incident.opened",
        resourceType: "monitor",
        resourceId: monitor.id,
        title: `${monitor.name} is down`,
        summary: `${monitor.kind.toUpperCase()} check failed: ${result.info}`,
        link: `/monitoring/${monitor.id}`,
        ts: now,
      }).catch(() => { /* best-effort */ });
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
      const downSecs = Math.round((now.getTime() - new Date(open.startedAt).getTime()) / 1000);
      await notifyAll(
        "monitor.incident.resolved",
        `${monitor.name} is back up`,
        `${monitor.kind.toUpperCase()} recovered after ${downSecs}s`,
        `/monitoring/${monitor.id}`,
      );
      await db.insert(activityEvents).values({
        actorUserId: null,
        actorEmail: null,
        action: "monitor.incident.resolved",
        resourceType: "monitor",
        resourceId: monitor.id,
        title: `${monitor.name} is back up`,
        summary: `${monitor.kind.toUpperCase()} recovered after ${downSecs}s`,
        link: `/monitoring/${monitor.id}`,
        ts: now,
      }).catch(() => { /* best-effort */ });
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
        const result = await runProbe(m.kind, m.target, (m.options as Record<string, unknown>) ?? {});
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
    const r = await db.delete(monitorChecks).where(lt(monitorChecks.ts, cutoff));
    console.log(`[monitor] pruned checks older than ${PRUNE_KEEP_DAYS}d (${(r as { rowCount?: number }).rowCount ?? "?"} rows)`);
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
