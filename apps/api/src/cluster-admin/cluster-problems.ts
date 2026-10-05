import type { ClusterJobInfo, ClusterNodeInfo, ClusterProblem, ClusterStoreInfo, ClusterDatabaseInfo } from "@church/shared";

/** A node that has not checked in for this long is reported as stopped (the heartbeat is every 10 s). */
export const NODE_STALE_SEC = 60;
/** Above this a database round trip is worth a warning. */
const SLOW_DB_MS = 1000;

export interface ProblemInput {
  nodes: ClusterNodeInfo[];
  /** Names of the jobs this release registers (every node registers the same ones). */
  registeredJobs: string[];
  jobs: ClusterJobInfo[];
  database: ClusterDatabaseInfo;
  store: ClusterStoreInfo;
}

const fmtAge = (sec: number): string => (sec < 90 ? `${Math.round(sec)} seconds` : sec < 5400 ? `${Math.round(sec / 60)} minutes` : `${Math.round(sec / 3600)} hours`);

/**
 * What is wrong, in order of how much it matters. Pure, so each rule is tested on its own. Normal
 * conditions are not problems: a node that left cleanly has no row at all, and different builds
 * during a rolling upgrade are only a warning.
 */
export function findProblems(input: ProblemInput): ClusterProblem[] {
  const out: ClusterProblem[] = [];
  const { nodes, database, store } = input;

  if (!database.ok) out.push({ severity: "error", message: `The database is not answering from this node${database.error ? `: ${database.error}` : ""}.` });
  else if (database.latencyMs !== null && database.latencyMs > SLOW_DB_MS) out.push({ severity: "warning", message: `The database is slow to answer (${database.latencyMs} ms for a trivial query).` });

  if (!store.ok) out.push({ severity: "error", message: `The object store is not answering from this node${store.error ? `: ${store.error}` : ""}. Uploads and downloads of files will fail.` });
  for (const n of store.garage?.nodes ?? []) {
    if (!n.up) out.push({ severity: "error", message: `Object store node ${n.id.slice(0, 8)}${n.addr ? ` (${n.addr})` : ""} is down${n.lastSeenSecsAgo !== null ? `: last seen ${fmtAge(n.lastSeenSecsAgo)} ago` : ""}.` });
    else if (n.draining) out.push({ severity: "warning", message: `Object store node ${n.id.slice(0, 8)} is being drained.` });
  }

  for (const n of nodes) {
    if (!n.live && n.ageSec >= NODE_STALE_SEC) {
      out.push({ severity: "error", message: `Node ${n.id}${n.addr ? ` (${n.addr})` : ""} stopped checking in ${fmtAge(n.ageSec)} ago. If it was taken out on purpose this clears itself within an hour.` });
    }
  }

  const live = nodes.filter((n) => n.live && n.role === "full");
  const builds = new Set(live.map((n) => n.version ?? "unknown"));
  if (builds.size > 1) {
    const list = [...builds].map((b) => `${b} on ${live.filter((n) => (n.version ?? "unknown") === b).map((n) => n.id).join(", ")}`).join("; ");
    out.push({ severity: "warning", message: `Nodes are running different builds (${list}). Expected during a rolling upgrade; otherwise a node was not upgraded.` });
  }

  // A job nobody leads is not running anywhere. Only meaningful when some node is allowed to run jobs.
  if (live.length > 0) {
    const held = new Map(input.jobs.filter((j) => j.held).map((j) => [j.name, j]));
    const missing = input.registeredJobs.filter((name) => !held.has(name));
    if (missing.length > 0) {
      out.push({
        severity: "warning",
        message: `${missing.length} background job${missing.length === 1 ? " has" : "s have"} no leader right now: ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? ", ..." : ""}. Every node may have BACKGROUND_JOBS=off, or the jobs are still starting.`,
      });
    }
  }

  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
}
