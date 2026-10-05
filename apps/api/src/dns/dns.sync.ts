import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  NotFoundException,
  type OnModuleInit,
  type OnModuleDestroy,
} from "@nestjs/common";
import { desc, eq, isNotNull, lt } from "drizzle-orm";
import {
  DNS_MANAGED_MARKER,
  type DnsRecordData,
  type DnsSyncAction,
  type DnsSyncHostOutcome,
  type DnsSyncPlan,
  type DnsSyncRun,
  type DnsSyncRunDetails,
  type DnsSyncStatus,
  type DnsSyncTrigger,
} from "@church/shared";
import { DB, type Db } from "../db/db.module";
import { dnsManagedRecords, dnsSyncRuns, ipamHosts, ipamSubnets } from "../db/schema";
import { SettingsService } from "../settings/settings.service";
import { ClusterJobs } from "../cluster/cluster-jobs.service";
import { LeaseService } from "../cluster/lease.service";
import { DnsService } from "./dns.service";
import { DnsSearchIndexer } from "./dns.search-indexer";
import {
  technitiumCall,
  TechnitiumError,
  dataParams,
  newDataParams,
  formatRData,
  parseRData,
  type TechnitiumConfig,
  type TRecord,
  type TZone,
} from "./technitium";
import { computeSyncPlan, recordKey, type ComputedSyncPlan, type ExistingRecord } from "./sync-plan";

/** A sync is already running somewhere in the cluster. */
class AlreadyRunningError extends BadRequestException {
  constructor() {
    super("A DNS sync is already running");
  }
}

// Fallback cadence; the IPAM scanner and IPAM edits trigger runs sooner.
const TIMER_MS = 15 * 60_000;
const STARTUP_DELAY_MS = 60_000;
const DEBOUNCE_MS = 5_000;
const RUN_RETENTION_DAYS = 90;

interface SyncConfig {
  enabled: boolean;
  zone: string;
  ptr: boolean;
  ttl: number;
  staleDays: number;
}

type RunRow = typeof dnsSyncRuns.$inferSelect;

/**
 * IPAM -> DNS sync runner. Reads the hosts of every subnet with "Publish to
 * DNS" on, reads what Technitium holds, diffs with computeSyncPlan, applies
 * the changes and records the run. Only records carrying DNS_MANAGED_MARKER
 * are ever changed or removed.
 *
 * Triggers: the end of every IPAM scanner pass and IPAM edits (debounced), a
 * 15-minute fallback timer, and the DNS page's "Sync now". Background runs only
 * happen while `dns.sync_enabled` is on. One run at a time across the whole
 * cluster: the 15-minute timer is a cluster job (one node), and every run, from
 * any node and any trigger, holds the `dns-sync` mutex lease while it works.
 *
 * Background changes never pass through the HTTP audit interceptor, so
 * `dns_sync_runs` is their audit trail: every applied action, and who pressed
 * the button for manual runs.
 */
@Injectable()
export class DnsSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DnsSyncService.name);
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private pendingTrigger: DnsSyncTrigger = "timer";

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly dns: DnsService,
    private readonly indexer: DnsSearchIndexer,
    private readonly jobs: ClusterJobs,
    private readonly leases: LeaseService,
  ) {}

  onModuleInit(): void {
    this.jobs.register({
      name: "dns-sync",
      everyMs: TIMER_MS,
      initialDelayMs: STARTUP_DELAY_MS,
      run: () => this.backgroundRun("timer"),
    });
  }

  onModuleDestroy(): void {
    if (this.debounce) clearTimeout(this.debounce);
  }

  /** Background trigger: debounced, and a no-op while sync is off. */
  requestRun(trigger: Exclude<DnsSyncTrigger, "manual">): void {
    this.pendingTrigger = trigger;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.backgroundRun(this.pendingTrigger), DEBOUNCE_MS);
  }

  /** One background run: skipped while sync is off or unconfigured; failures are logged. */
  private async backgroundRun(trigger: DnsSyncTrigger): Promise<void> {
    const cfg = await this.syncConfig();
    if (!cfg.enabled || !cfg.zone) return;
    await this.run(trigger, null, false).catch((err: unknown) => {
      // Another run (any node) holding the lock is normal, not a failure.
      if (err instanceof AlreadyRunningError) this.logger.debug(`dns sync (${trigger}) skipped: already running`);
      else this.logger.warn(`dns sync (${trigger}) failed: ${(err as Error).message}`);
    });
  }

  private async syncConfig(): Promise<SyncConfig> {
    const get = (k: string) => this.settings.get(k);
    const num = async (k: string, d: number): Promise<number> => {
      const v = await get(k);
      return typeof v === "number" && Number.isFinite(v) ? v : d;
    };
    return {
      enabled: ((await get("dns.sync_enabled")) as boolean | undefined) ?? false,
      zone: (((await get("dns.sync_zone")) as string | undefined) ?? "").trim().toLowerCase().replace(/\.$/, ""),
      ptr: ((await get("dns.sync_ptr")) as boolean | undefined) ?? true,
      ttl: Math.max(0, Math.trunc(await num("dns.record_ttl", 300))),
      staleDays: Math.max(1, await num("dns.stale_days", 14)),
    };
  }

  /** Preview: what a run would do now. Works while sync is off. */
  async plan(): Promise<DnsSyncPlan> {
    const { plan } = await this.compute();
    return stripInternal(plan);
  }

  private async compute(): Promise<{ plan: ComputedSyncPlan; cfg: SyncConfig; conn: TechnitiumConfig }> {
    const cfg = await this.syncConfig();
    if (!cfg.zone) throw new BadRequestException("Set the DNS sync zone in Monitoring settings first");
    const conn = await this.dns.requireConfig();

    const zones = await this.call<{ zones?: TZone[] }>(conn, "zones/list");
    const zoneList = (zones.zones ?? []).filter((z) => !z.internal && z.name);
    const syncZone = zoneList.find((z) => z.name?.toLowerCase() === cfg.zone);
    if (!syncZone) throw new BadRequestException(`Zone ${cfg.zone} doesn't exist on the Technitium primary`);
    if (syncZone.type !== "Primary") {
      throw new BadRequestException(`Zone ${cfg.zone} is a ${syncZone.type} zone; the sync needs a Primary zone`);
    }

    const ledger = await this.db.select().from(dnsManagedRecords);
    // Read the sync zone, every primary reverse zone, and any zone the ledger
    // still points at (e.g. after the sync zone was renamed) so old records
    // can be cleaned up.
    const toRead = new Set<string>([cfg.zone]);
    for (const z of zoneList) {
      const n = z.name!.toLowerCase();
      if (z.type === "Primary" && n.endsWith("in-addr.arpa")) toRead.add(n);
    }
    const hosted = new Set(zoneList.map((z) => z.name!.toLowerCase()));
    for (const l of ledger) if (hosted.has(l.zone)) toRead.add(l.zone);

    const existing: ExistingRecord[] = [];
    for (const zone of toRead) {
      const res = await this.call<{ records?: TRecord[] }>(conn, "zones/records/get", {
        domain: zone,
        zone,
        listZone: true,
      });
      for (const r of res.records ?? []) {
        if (!r.type || !r.name) continue;
        const data = parseRData(r.type, r.rData);
        const value =
          data?.type === "A" ? data.ipAddress : data?.type === "PTR" ? data.ptrName.toLowerCase() : formatRData(r.type, r.rData);
        existing.push({
          zone,
          name: r.name.toLowerCase(),
          type: r.type,
          value,
          ttl: typeof r.ttl === "number" ? r.ttl : 0,
          comments: r.comments ?? null,
        });
      }
    }

    const hosts = await this.db
      .select({
        id: ipamHosts.id,
        ipAddress: ipamHosts.ipAddress,
        dnsName: ipamHosts.dnsName,
        unifiName: ipamHosts.unifiName,
        netbiosName: ipamHosts.netbiosName,
        lastSeenAt: ipamHosts.lastSeenAt,
      })
      .from(ipamHosts)
      .innerJoin(ipamSubnets, eq(ipamHosts.subnetId, ipamSubnets.id))
      .where(eq(ipamSubnets.dnsSync, true));

    const plan = computeSyncPlan({
      enabled: cfg.enabled,
      zone: cfg.zone,
      ptr: cfg.ptr,
      ttl: cfg.ttl,
      staleDays: cfg.staleDays,
      now: new Date(),
      hosts,
      zones: [...hosted],
      existing,
      ledger: new Map(ledger.map((l) => [recordKey(l.zone, l.name, l.type), l.ipamHostId])),
    });
    return { plan, cfg, conn };
  }

  /**
   * Apply a plan. Manual runs need sync turned on too: the preview is how to
   * look before enabling. `force` applies past the safety limit.
   */
  async run(trigger: DnsSyncTrigger, actorUserId: string | null, force: boolean): Promise<DnsSyncRun> {
    if (!(await this.syncConfig()).enabled) {
      throw new BadRequestException('Turn on "Sync IPAM hosts to DNS" in Monitoring settings first');
    }
    // One run at a time across all nodes. 120s TTL, renewed while the run works.
    const mutex = await this.leases.acquireMutex("dns-sync", 120);
    if (!mutex) throw new AlreadyRunningError();
    let runRow: typeof dnsSyncRuns.$inferSelect | undefined;
    try {
      [runRow] = await this.db
        .insert(dnsSyncRuns)
        .values({ trigger, actorUserId, startedAt: new Date() })
        .returning();
    } catch (err) {
      await mutex.release();
      throw err;
    }
    const runId = runRow!.id;
    try {
      const { plan, cfg, conn } = await this.compute();

      if (plan.blocked && !force) {
        return toRun(
          await this.finish(runId, {
            conflicts: plan.conflicts.length,
            error: plan.blocked,
            details: detailsOf(plan, [], plan.hosts),
          }),
        );
      }

      const applied: DnsSyncAction[] = [];
      const hosts: Record<string, DnsSyncHostOutcome> = { ...plan.hosts };
      const failedKeys = new Map<string, string>();
      for (const a of plan.actions) {
        // If a stall let another node take the lock, stop rather than write alongside it.
        if (mutex.lost) throw new Error("The DNS sync lock was lost to another node; stopping");
        try {
          await this.apply(conn, a);
          applied.push(a);
        } catch (err) {
          const msg = (err as Error).message;
          // Already gone counts as removed. Technitium deletes a PTR along with
          // the A record it points back at, so a PTR removal that follows its
          // A removal in the same run finds nothing left.
          if (a.op === "remove" && /no such record/i.test(msg)) {
            applied.push(a);
            continue;
          }
          applied.push({ ...a, error: msg });
          failedKeys.set(recordKey(a.zone, a.name, a.type), msg);
          if (a.ipamHostId && hosts[a.ipamHostId]) {
            hosts[a.ipamHostId] = { ...hosts[a.ipamHostId]!, state: "error", message: msg };
          }
        }
      }

      await this.rebuildLedger(plan, cfg.ttl, failedKeys);
      const count = (op: DnsSyncAction["op"]) => applied.filter((a) => a.op === op && !a.error).length;
      const row = await this.finish(runId, {
        added: count("add"),
        updated: count("update"),
        removed: count("remove"),
        conflicts: plan.conflicts.length,
        failed: applied.filter((a) => a.error).length,
        error: null,
        details: detailsOf(plan, applied, hosts),
      });
      if (applied.length > 0) this.indexer.requestSync();
      return toRun(row);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.finish(runId, { error: msg, details: { actions: [], conflicts: [], missingReverseZones: [], hosts: {}, blocked: null } });
      throw err;
    } finally {
      await mutex.release();
      void this.prune();
    }
  }

  private async apply(conn: TechnitiumConfig, a: DnsSyncAction): Promise<void> {
    const data = (v: string): DnsRecordData => (a.type === "A" ? { type: "A", ipAddress: v } : { type: "PTR", ptrName: v });
    const base = { zone: a.zone, domain: a.name, type: a.type };
    if (a.op === "add") {
      await this.write(conn, "zones/records/add", { ...base, ttl: a.ttl, comments: DNS_MANAGED_MARKER, ...dataParams(data(a.value)) });
    } else if (a.op === "update") {
      await this.write(conn, "zones/records/update", {
        ...base,
        ttl: a.ttl,
        disable: false,
        comments: DNS_MANAGED_MARKER,
        ...dataParams(data(a.fromValue ?? a.value)),
        ...newDataParams(data(a.value)),
      });
    } else {
      await this.write(conn, "zones/records/delete", { ...base, ...dataParams(data(a.value)) });
    }
  }

  /** The ledger mirrors what the sync owns after this run. */
  private async rebuildLedger(plan: ComputedSyncPlan, ttl: number, failed: Map<string, string>): Promise<void> {
    const now = new Date();
    const rows = plan.published.map((p) => {
      const err = failed.get(recordKey(p.zone, p.name, p.type)) ?? null;
      return {
        ipamHostId: p.hostId,
        zone: p.zone,
        name: p.name,
        type: p.type,
        value: p.value,
        ttl,
        state: err ? "error" : "ok",
        lastError: err,
        lastSyncedAt: now,
        updatedAt: now,
      };
    });
    await this.db.transaction(async (tx) => {
      await tx.delete(dnsManagedRecords);
      if (rows.length) await tx.insert(dnsManagedRecords).values(rows);
    });
  }

  private async finish(
    id: string,
    patch: Partial<Pick<RunRow, "added" | "updated" | "removed" | "conflicts" | "failed" | "error">> & { details: DnsSyncRunDetails },
  ): Promise<RunRow> {
    const [row] = await this.db
      .update(dnsSyncRuns)
      .set({ ...patch, finishedAt: new Date() })
      .where(eq(dnsSyncRuns.id, id))
      .returning();
    return row!;
  }

  private async prune(): Promise<void> {
    try {
      await this.db
        .delete(dnsSyncRuns)
        .where(lt(dnsSyncRuns.startedAt, new Date(Date.now() - RUN_RETENTION_DAYS * 86_400_000)));
    } catch (err) {
      this.logger.debug(`dns sync run prune failed: ${(err as Error).message}`);
    }
  }

  async runs(limit = 20): Promise<DnsSyncRun[]> {
    const rows = await this.db.select().from(dnsSyncRuns).orderBy(desc(dnsSyncRuns.startedAt)).limit(limit);
    return rows.map(toRun);
  }

  /** Last completed run's per-host outcomes, for the IPAM subnet page. */
  async status(): Promise<DnsSyncStatus> {
    const cfg = await this.syncConfig();
    // Host outcomes come from the newest finished run that computed a plan
    // (a run that failed before planning stores none); blocked runs count,
    // since their plan still says how each host stands.
    const recent = await this.db
      .select()
      .from(dnsSyncRuns)
      .where(isNotNull(dnsSyncRuns.finishedAt))
      .orderBy(desc(dnsSyncRuns.startedAt))
      .limit(10);
    const withHosts = recent.find((r) => Object.keys((r.details as DnsSyncRunDetails | null)?.hosts ?? {}).length > 0);
    return {
      enabled: cfg.enabled,
      zone: cfg.zone,
      lastRun: recent[0] ? toRun(recent[0]) : null,
      hosts: (withHosts?.details as DnsSyncRunDetails | undefined)?.hosts ?? {},
    };
  }

  /**
   * Hand a synced record over to the operator: strip the managed-by comment
   * and forget it. The next run sees a hand-made record at that name and
   * reports a conflict for its host instead of changing it.
   */
  async release(id: string): Promise<{ id: string; zone: string; name: string; type: string; value: string }> {
    const [row] = await this.db.select().from(dnsManagedRecords).where(eq(dnsManagedRecords.id, id)).limit(1);
    if (!row) throw new NotFoundException("Synced record not found");
    const conn = await this.dns.requireConfig();
    const data: DnsRecordData = row.type === "A" ? { type: "A", ipAddress: row.value } : { type: "PTR", ptrName: row.value };
    try {
      await this.write(conn, "zones/records/update", {
        zone: row.zone,
        domain: row.name,
        type: row.type,
        ttl: row.ttl,
        disable: false,
        comments: "",
        ...dataParams(data),
        ...newDataParams(data),
      });
    } catch (err) {
      // Already gone from Technitium: just forget it.
      if (!(err instanceof BadRequestException)) throw err;
    }
    await this.db.delete(dnsManagedRecords).where(eq(dnsManagedRecords.id, id));
    return { id: row.id, zone: row.zone, name: row.name, type: row.type, value: row.value };
  }

  /** The ledger, for the Sync view. */
  async managed(): Promise<Array<typeof dnsManagedRecords.$inferSelect>> {
    return this.db.select().from(dnsManagedRecords).orderBy(dnsManagedRecords.zone, dnsManagedRecords.name);
  }

  /** Create a Primary reverse zone the plan reported missing. */
  async createReverseZone(zone: string): Promise<{ id: string; zone: string }> {
    const conn = await this.dns.requireConfig();
    await this.write(conn, "zones/create", { zone, type: "Primary" });
    return { id: zone, zone };
  }

  private async call<T>(conn: TechnitiumConfig, path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    try {
      return await technitiumCall<T>(conn, path, params);
    } catch (err) {
      if (err instanceof TechnitiumError) throw new BadRequestException(`Technitium: ${err.message}`);
      throw err;
    }
  }

  private async write(conn: TechnitiumConfig, path: string, params: Record<string, string | number | boolean | undefined>): Promise<void> {
    try {
      await technitiumCall<unknown>(conn, path, params, "POST");
    } catch (err) {
      if (err instanceof TechnitiumError) throw new BadRequestException(err.message);
      throw err;
    }
  }
}

function stripInternal(plan: ComputedSyncPlan): DnsSyncPlan {
  const { published: _published, ...rest } = plan;
  return rest;
}

function detailsOf(
  plan: DnsSyncPlan,
  actions: DnsSyncAction[],
  hosts: Record<string, DnsSyncHostOutcome>,
): DnsSyncRunDetails {
  return {
    actions,
    conflicts: plan.conflicts,
    missingReverseZones: plan.missingReverseZones,
    hosts,
    blocked: plan.blocked,
  };
}

function toRun(r: RunRow): DnsSyncRun {
  return {
    id: r.id,
    trigger: r.trigger as DnsSyncTrigger,
    actorUserId: r.actorUserId,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    added: r.added,
    updated: r.updated,
    removed: r.removed,
    conflicts: r.conflicts,
    failed: r.failed,
    error: r.error,
  };
}
