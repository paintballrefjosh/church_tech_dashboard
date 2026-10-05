/**
 * What the admin Cluster page shows (apps/api/src/cluster-admin/): every app node, which node
 * leads each background job, the database and the object store, and a list of problems worked out
 * from them. Plain data, so the page and the API agree on one shape.
 */

export interface ClusterNodeInfo {
  id: string;
  role: "full" | "data";
  addr: string | null;
  version: string | null;
  startedAt: string;
  lastSeen: string;
  /** Seconds since the node last checked in (by the database's clock). */
  ageSec: number;
  /** Checked in within the last 30 seconds. */
  live: boolean;
  /** The node that answered this request. */
  self: boolean;
}

export interface ClusterJobInfo {
  name: string;
  /** The node holding the job's lease, or null when nobody does. */
  node: string | null;
  epoch: number | null;
  /** Seconds until the lease lapses (negative: already lapsed). */
  expiresInSec: number | null;
  held: boolean;
}

export interface ClusterDatabaseInfo {
  /** `cockroachdb`, `yugabytedb` or `postgresql`. */
  engine: string;
  /** Human text, e.g. "CockroachDB v24.2.0". */
  label: string;
  latencyMs: number | null;
  ok: boolean;
  error?: string;
}

export interface ClusterStoreNode {
  id: string;
  addr: string | null;
  zone: string | null;
  capacityBytes: number | null;
  up: boolean;
  lastSeenSecsAgo: number | null;
  dataAvailableBytes: number | null;
  dataTotalBytes: number | null;
  draining: boolean;
}

export interface ClusterStoreInfo {
  /** `garage` (the bundled one) or `s3` (your own). */
  kind: string;
  endpoint: string;
  bucket: string;
  ok: boolean;
  latencyMs: number | null;
  error?: string;
  /** Only for the bundled Garage, from its admin API. */
  garage: { layoutVersion: number; nodes: ClusterStoreNode[] } | null;
}

export type ClusterProblemSeverity = "error" | "warning";

export interface ClusterProblem {
  severity: ClusterProblemSeverity;
  message: string;
}

export interface ClusterStatus {
  generatedAt: string;
  self: string;
  /** This node's build id. */
  build: string | null;
  nodes: ClusterNodeInfo[];
  jobs: ClusterJobInfo[];
  /** Leases held for one-off work right now (a backup, a restore), by name. */
  operations: Array<{ name: string; node: string | null; expiresInSec: number }>;
  database: ClusterDatabaseInfo;
  store: ClusterStoreInfo;
  problems: ClusterProblem[];
}
