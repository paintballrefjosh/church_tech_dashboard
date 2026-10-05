import { ConflictException, Inject, Injectable, Logger, NotFoundException, type OnModuleInit } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { DEFAULT_GROUPS, type ClusterDatabaseInfo, type ClusterJobInfo, type ClusterNodeInfo, type ClusterStatus, type ClusterStoreInfo } from "@church/shared";
import { DB, type Db } from "../db/db.module";
import { clusterLeases, clusterNodes, groupMemberships, groups } from "../db/schema";
import { ClusterJobs } from "../cluster/cluster-jobs.service";
import { JobStateService } from "../cluster/job-state.service";
import { NODE_LIVE_SEC, NodeService } from "../cluster/node.service";
import { NotificationsService } from "../notifications/notifications.service";
import { SettingsService } from "../settings/settings.service";
import { getS3 } from "../attachments/s3.client";
import { describeS3, resolveS3Config } from "../attachments/s3.config";
import { engineFromVersion, engineLabel } from "../db/connection";
import { findProblems, NODE_STALE_SEC } from "./cluster-problems";
import { fetchGarageStatus } from "./garage-status";

const PROBE_MS = 2500;
const WATCH_EVERY_MS = 30_000;

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(msg)), ms))]);
}

/**
 * Who a lease holder is: `<node id>/<instance prefix>` (a mutex adds `#suffix`) is an app node; the monitor
 * worker holds its own leases as `monitor/<host>/<id>`.
 */
function nodeOfHolder(holder: string): string {
  const parts = holder.split("/");
  if (parts[0] === "monitor" && parts.length >= 3) return `monitor worker (${parts[1]})`;
  return parts[0] ?? holder;
}

/**
 * What the admin Cluster page shows, and the watch that tells the administrators when an app node
 * stops checking in (docs/multi-node.md). Reads only: the cluster coordinates itself through
 * `apps/api/src/cluster/`; this looks at the result.
 */
@Injectable()
export class ClusterAdminService implements OnModuleInit {
  private readonly logger = new Logger(ClusterAdminService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly node: NodeService,
    private readonly jobs: ClusterJobs,
    private readonly jobState: JobStateService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
  ) {}

  onModuleInit(): void {
    this.jobs.register({ name: "cluster-watch", everyMs: WATCH_EVERY_MS, schedule: "fixed-delay", initialDelayMs: 45_000, run: () => this.watch() });
  }

  async status(): Promise<ClusterStatus> {
    const [nodes, leases, database, store] = await Promise.all([this.nodes(), this.leases(), this.probeDatabase(), this.probeStore()]);
    const registered = this.jobs.jobNames();
    const jobs = this.jobsFrom(leases, registered);
    return {
      generatedAt: new Date().toISOString(),
      self: this.node.identity.nodeId,
      build: process.env.BUILD_ID ?? null,
      nodes,
      jobs,
      operations: leases
        .filter((l) => l.name.startsWith("mutex:") && l.expiresInSec > 0)
        .map((l) => ({ name: l.name.slice("mutex:".length), node: nodeOfHolder(l.holder), expiresInSec: Math.round(l.expiresInSec) })),
      database,
      store,
      problems: findProblems({ nodes, registeredJobs: registered, jobs, database, store }),
    };
  }

  private async nodes(): Promise<ClusterNodeInfo[]> {
    const rows = await this.db
      .select({ n: clusterNodes, age: sql<number>`extract(epoch from (now() - ${clusterNodes.lastSeen}))` })
      .from(clusterNodes)
      .orderBy(clusterNodes.id);
    return rows.map(({ n, age }) => ({
      id: n.id,
      role: n.role === "data" ? "data" : "full",
      addr: n.addr,
      version: n.version,
      startedAt: n.startedAt.toISOString(),
      lastSeen: n.lastSeen.toISOString(),
      ageSec: Math.max(0, Math.round(Number(age))),
      live: Number(age) <= NODE_LIVE_SEC,
      self: n.id === this.node.identity.nodeId,
    }));
  }

  private async leases(): Promise<Array<{ name: string; holder: string; epoch: number; expiresInSec: number }>> {
    const rows = await this.db
      .select({ name: clusterLeases.name, holder: clusterLeases.holder, epoch: clusterLeases.epoch, left: sql<number>`extract(epoch from (${clusterLeases.expiresAt} - now()))` })
      .from(clusterLeases)
      .where(sql`${clusterLeases.name} LIKE 'job:%' OR ${clusterLeases.name} LIKE 'mutex:%'`);
    return rows.map((r) => ({ name: r.name, holder: r.holder, epoch: r.epoch, expiresInSec: Number(r.left) }));
  }

  private jobsFrom(leases: Array<{ name: string; holder: string; epoch: number; expiresInSec: number }>, registered: string[]): ClusterJobInfo[] {
    const byName = new Map(leases.filter((l) => l.name.startsWith("job:")).map((l) => [l.name.slice(4), l]));
    const names = [...new Set([...registered, ...byName.keys()])].sort();
    return names.map((name) => {
      const l = byName.get(name);
      const held = !!l && l.expiresInSec > 0;
      return { name, node: l ? nodeOfHolder(l.holder) : null, epoch: l?.epoch ?? null, expiresInSec: l ? Math.round(l.expiresInSec) : null, held };
    });
  }

  private async probeDatabase(): Promise<ClusterDatabaseInfo> {
    const t0 = Date.now();
    try {
      const res = await withTimeout(this.db.execute<{ version: string }>(sql`SELECT version() AS version`), PROBE_MS, "timed out");
      const version = String((res.rows[0] as { version?: unknown } | undefined)?.version ?? "");
      const engine = engineFromVersion(version);
      return { engine, label: engineLabel(engine, version), latencyMs: Date.now() - t0, ok: true };
    } catch (err) {
      return { engine: "unknown", label: "Database", latencyMs: null, ok: false, error: (err as Error).message };
    }
  }

  private async probeStore(): Promise<ClusterStoreInfo> {
    const t0 = Date.now();
    let cfg;
    try {
      cfg = resolveS3Config();
    } catch (err) {
      return { kind: "s3", endpoint: "", bucket: "", ok: false, latencyMs: null, error: (err as Error).message, garage: null };
    }
    const info = describeS3(cfg);
    const kind = cfg.endPoint === "garage" ? "garage" : "s3";
    const [bucket, garage] = await Promise.all([
      withTimeout(getS3().client.bucketExists(cfg.bucket), PROBE_MS, "timed out").then(
        (exists) => ({ ok: exists, error: exists ? undefined : `bucket "${cfg.bucket}" does not exist` }),
        (err: Error) => ({ ok: false, error: err.message }),
      ),
      kind === "garage" ? fetchGarageStatus(process.env.GARAGE_ADMIN_URL, process.env.GARAGE_ADMIN_TOKEN) : Promise.resolve(null),
    ]);
    return { kind, endpoint: info.endpoint ?? "", bucket: cfg.bucket, ok: bucket.ok, latencyMs: Date.now() - t0, error: bucket.error, garage };
  }

  /** Remove the row of a node that is not coming back (a stopped one clears itself after an hour). A live node is refused. */
  async forgetNode(id: string): Promise<{ ok: true }> {
    const [row] = await this.db
      .select({ age: sql<number>`extract(epoch from (now() - ${clusterNodes.lastSeen}))` })
      .from(clusterNodes)
      .where(eq(clusterNodes.id, id))
      .limit(1);
    if (!row) throw new NotFoundException("No such node");
    if (Number(row.age) <= NODE_LIVE_SEC) throw new ConflictException("That node is checking in: stop it first.");
    await this.db.delete(clusterNodes).where(eq(clusterNodes.id, id));
    await this.dropAlerted(id);
    return { ok: true };
  }

  // ------------------------------------------------------------------ the watch

  private async alerted(): Promise<string[]> {
    const s = await this.jobState.get<string[]>("cluster-watch", "alerted");
    return s?.value ?? [];
  }

  private async dropAlerted(id: string): Promise<void> {
    const cur = await this.alerted();
    if (cur.includes(id)) await this.jobState.set("cluster-watch", "alerted", cur.filter((x) => x !== id));
  }

  /**
   * Every 30 seconds, on the node leading the job: tell the administrators about a node that stopped
   * checking in, and again when it is back. Nodes that left cleanly delete their own row and never show
   * up here; the baseline of who has been reported lives in `job_state`, so a new leader does not repeat itself.
   */
  async watch(): Promise<void> {
    const nodes = await this.nodes();
    const stale = new Map(nodes.filter((n) => !n.live && n.ageSec >= NODE_STALE_SEC).map((n) => [n.id, n]));
    const known = new Set(nodes.map((n) => n.id));
    const before = await this.alerted();
    const down = [...stale.keys()].filter((id) => !before.includes(id));
    const back = before.filter((id) => known.has(id) && !stale.has(id));
    // A reported node whose row is gone (it was forgotten, or aged out) is simply no longer tracked.
    const next = before.filter((id) => stale.has(id)).concat(down);
    if (down.length > 0 || back.length > 0 || next.length !== before.length) await this.jobState.set("cluster-watch", "alerted", next);
    if (down.length === 0 && back.length === 0) return;
    if ((await this.settings.get("monitoring.maintenance_mode")) === true) return;
    for (const id of down) {
      const n = stale.get(id)!;
      await this.notify(`App node ${id} stopped`, `It has not checked in for ${Math.round(n.ageSec / 60) || 1} minute(s)${n.addr ? ` (${n.addr})` : ""}. Its background jobs have moved to the other nodes.`);
    }
    for (const id of back) await this.notify(`App node ${id} is back`, "It is checking in again.");
  }

  private async notify(title: string, body: string): Promise<void> {
    try {
      const [adminGroup] = await this.db.select({ id: groups.id }).from(groups).where(eq(groups.name, DEFAULT_GROUPS.ADMIN)).limit(1);
      if (!adminGroup) return;
      const admins = await this.db.select({ userId: groupMemberships.userId }).from(groupMemberships).where(eq(groupMemberships.groupId, adminGroup.id));
      await this.notifications.createMany(admins.map((a) => ({ recipientUserId: a.userId, kind: "cluster.node_down", title, body, link: "/admin/cluster" })));
    } catch (err) {
      this.logger.warn(`could not notify admins: ${(err as Error).message}`);
    }
  }
}
