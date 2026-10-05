import { Inject, Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { clusterNodes } from "../db/schema";
import { nodeIdentityFromEnv, type NodeIdentity } from "./node-identity";

const HEARTBEAT_MS = 10_000;
/** A node is considered live when it has heartbeated within this many seconds. */
export const NODE_LIVE_SEC = 30;

/**
 * This node's identity plus a heartbeat row in `cluster_nodes`, so other nodes
 * (and the admin Cluster page, later) can see who is alive. Failures are logged
 * and retried; nothing here may stop the app from starting, for instance while
 * migrations have not been applied yet on a fresh install.
 */
@Injectable()
export class NodeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NodeService.name);
  readonly identity: NodeIdentity = nodeIdentityFromEnv();
  private timer: NodeJS.Timeout | null = null;

  constructor(@Inject(DB) private readonly db: Db) {}

  onModuleInit(): void {
    this.logger.log(
      `node ${this.identity.nodeId} (${this.identity.role}), background jobs ${this.identity.backgroundJobs ? "on" : "OFF"}`,
    );
    void this.beat();
    this.timer = setInterval(() => void this.beat(), HEARTBEAT_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Drop our row so peers see the node leave rather than wait out the heartbeat.
    await this.db
      .delete(clusterNodes)
      .where(eq(clusterNodes.instanceId, this.identity.instanceId))
      .catch(() => undefined);
  }

  private async beat(): Promise<void> {
    const id = this.identity;
    try {
      await this.db
        .insert(clusterNodes)
        .values({
          id: id.nodeId,
          instanceId: id.instanceId,
          role: id.role,
          addr: id.addr,
          version: process.env.BUILD_ID ?? null,
        })
        .onConflictDoUpdate({
          target: clusterNodes.id,
          set: {
            startedAt: sql`CASE WHEN ${clusterNodes.instanceId} = excluded.instance_id THEN ${clusterNodes.startedAt} ELSE now() END`,
            instanceId: id.instanceId,
            role: id.role,
            addr: id.addr,
            version: process.env.BUILD_ID ?? null,
            lastSeen: sql`now()`,
          },
        });
      // Forget nodes that vanished without saying goodbye (a crash, a recreated
      // container under another NODE_ID). Idempotent, so any node may do it.
      await this.db
        .delete(clusterNodes)
        .where(sql`${clusterNodes.lastSeen} < now() - interval '1 hour'`);
    } catch (err) {
      this.logger.debug(`node heartbeat failed: ${(err as Error).message}`);
    }
  }

  /** Ids of nodes that have heartbeated recently (by the database's clock). */
  async liveNodeIds(): Promise<string[]> {
    const rows = await this.db
      .select({ id: clusterNodes.id })
      .from(clusterNodes)
      .where(sql`${clusterNodes.lastSeen} > now() - (${String(NODE_LIVE_SEC)}::text || ' seconds')::interval`);
    return rows.map((r) => r.id);
  }
}
