import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

/**
 * Who this process is, from the bootstrap environment. Pure (no database) so the
 * lease and job code can be tested without one.
 *
 *  - `NODE_ID`          stable name of this app node (default: the hostname)
 *  - `NODE_ROLE`        `full` (default) or `data`
 *  - `NODE_ADDR`        how other nodes reach this one (informational)
 *  - `BACKGROUND_JOBS`  `off` keeps this node from ever taking a periodic job,
 *                       for a node that cannot reach the monitored devices
 */
export interface NodeIdentity {
  /** Stable across restarts; must be unique per node. */
  nodeId: string;
  /** Random per process lifetime, so a restarted node is told apart from its old self. */
  instanceId: string;
  /** What leases are recorded under: `<nodeId>/<first 8 of instanceId>`. */
  holder: string;
  role: "full" | "data";
  addr: string | null;
  backgroundJobs: boolean;
}

export function nodeIdentityFromEnv(env: NodeJS.ProcessEnv = process.env): NodeIdentity {
  const nodeId = (env.NODE_ID ?? "").trim() || hostname();
  const instanceId = randomUUID();
  return {
    nodeId,
    instanceId,
    holder: `${nodeId}/${instanceId.slice(0, 8)}`,
    role: (env.NODE_ROLE ?? "").trim().toLowerCase() === "data" ? "data" : "full",
    addr: (env.NODE_ADDR ?? "").trim() || null,
    backgroundJobs: (env.BACKGROUND_JOBS ?? "").trim().toLowerCase() !== "off",
  };
}
