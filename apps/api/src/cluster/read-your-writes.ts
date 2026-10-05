import type { FastifyInstance } from "fastify";
import type { ClusterBus } from "./cluster-bus.service";

/**
 * Read your own writes across nodes (docs/multi-node.md). The load balancer has no stickiness, so the
 * request after a change can land on another node, whose caches (the user's permissions, settings) still
 * hold the old value until that node's next poll of the event channel, up to a second later. Without
 * this a person who changes their password and is sent on to the next page could be told to change it
 * again, or save a setting and be shown the old one.
 *
 * After a change the answering node writes the cache-invalidation events to the database *before*
 * replying, and the reply carries a cookie with the time of the change. A request that arrives with
 * that cookie makes its node run one poll of the event channel first if its last poll began before that
 * time. So a reader sees what its writer did, on any node, at the price of one extra query for
 * the requests in the few seconds after a change. A browser that never sends the cookie (an API client
 * that drops cookies) gets the old behaviour: consistent within about a second.
 */
export const CONSISTENCY_COOKIE = "church_rv";
/** How long after a change the cookie asks other nodes to catch up. */
const COOKIE_MAX_AGE_SEC = 10;
/** A cookie older than this, or dated in the future by more than the allowance, is ignored. */
const MAX_AGE_MS = 60_000;
const FUTURE_ALLOWANCE_MS = 5_000;

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** The time in a request's `church_rv` cookie, or null when absent or not believable. */
export function parseConsistencyCookie(header: string | undefined, now = Date.now()): number | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== CONSISTENCY_COOKIE) continue;
    const ms = Number(part.slice(eq + 1).trim());
    if (!Number.isFinite(ms)) return null;
    if (ms < now - MAX_AGE_MS || ms > now + FUTURE_ALLOWANCE_MS) return null;
    return ms;
  }
  return null;
}

export function consistencyCookie(nowMs: number): string {
  // HttpOnly and SameSite=Lax like every cookie here; no Secure (HTTPS is the load balancer's business).
  return `${CONSISTENCY_COOKIE}=${nowMs}; Path=/; Max-Age=${COOKIE_MAX_AGE_SEC}; HttpOnly; SameSite=Lax`;
}

/** Install the two hooks. A no-op unless `enabled` (a cluster; on a single node there is nobody to catch up with). */
export function registerReadYourWrites(fastify: FastifyInstance, bus: ClusterBus, enabled: boolean): void {
  if (!enabled) return;

  fastify.addHook("onRequest", async (req) => {
    const since = parseConsistencyCookie(req.headers.cookie);
    if (since !== null) await bus.syncSince(since);
  });

  fastify.addHook("onSend", async (req, reply, payload) => {
    if (!MUTATING.has(req.method)) return payload;
    await bus.flushNow().catch(() => undefined);
    const existing = reply.getHeader("set-cookie");
    const cookie = consistencyCookie(Date.now());
    reply.header("set-cookie", existing === undefined ? cookie : [...(Array.isArray(existing) ? existing : [String(existing)]), cookie]);
    return payload;
  });
}
