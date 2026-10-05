import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { SettingsService } from "../settings/settings.service";
import { NotificationsService } from "../notifications/notifications.service";
import { InfraService } from "../infra/infra.service";
import { SearchService } from "../search/search.service";
import { ClusterJobs } from "../cluster/cluster-jobs.service";
import { JobStateService } from "../cluster/job-state.service";
import { UnifiService } from "./unifi.service";

// UniFi has no push API — the controller is polled. We poll when either (a)
// someone is watching the Network tab (to push realtime snapshots) or (b)
// device-offline alerting is enabled (to catch transitions even with nobody
// watching). If neither is true we don't touch the controller.
const POLL_SEC = Math.max(5, parseInt(process.env.UNIFI_POLL_SEC ?? "20", 10));
const ROOM = "network";
const OFFLINE_ALERT_CAP = 10; // collapse to a summary beyond this many at once
// How often to refresh the search index when idle (no viewers, no alerting).
const SEARCH_SYNC_MS = Math.max(
  60_000,
  parseInt(process.env.UNIFI_SEARCH_SYNC_MS ?? "300000", 10) || 300_000,
);

interface DeviceState {
  online: boolean;
  name: string;
}

/**
 * Server-side UniFi poller. Pushes realtime snapshots to Network-tab viewers,
 * and (when enabled) tracks device up/down transitions to alert monitoring
 * admins on offline/recovery.
 */
@Injectable()
export class UnifiPoller implements OnModuleInit {
  private readonly logger = new Logger(UnifiPoller.name);
  private busy = false;
  private seeded = false;
  private lastSearchSyncAt = 0;
  private deviceStates = new Map<string, DeviceState>();

  constructor(
    private readonly unifi: UnifiService,
    private readonly realtime: RealtimeGateway,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
    private readonly infra: InfraService,
    private readonly search: SearchService,
    private readonly jobs: ClusterJobs,
    private readonly jobState: JobStateService,
  ) {}

  onModuleInit(): void {
    // A cluster job: one node polls the controller at a time. If leadership moves,
    // the new leader picks the alert baseline up from job_state (see
    // evaluateDeviceAlerts) instead of starting blind.
    this.jobs.register({ name: "unifi-poll", everyMs: POLL_SEC * 1000, run: () => this.tick() });
    this.logger.log(`UniFi poller scheduling every ${POLL_SEC}s`);
  }

  private async tick(): Promise<void> {
    if (this.busy) return; // don't stack a slow controller behind the interval
    // Anyone on any node: the poll runs on one node, the Network tab may be open on another.
    const viewers = this.realtime.hasViewers(ROOM);
    const alertEnabled = (await this.settings.get("unifi.alert_device_offline")) === true;
    // Even with nobody watching and alerting off, refresh the search index on a
    // slow cadence so UniFi devices/clients stay searchable (they live only on
    // the controller, not the DB — this poll is the sole indexing path).
    const searchDue =
      this.lastSearchSyncAt === 0 || Date.now() - this.lastSearchSyncAt >= SEARCH_SYNC_MS;
    if (!viewers && !alertEnabled && !searchDue) {
      // Nothing to do this tick; also forget baseline so we don't alert on a
      // stale snapshot when alerting is re-enabled later.
      this.seeded = false;
      return;
    }
    this.busy = true;
    try {
      const snapshot = await this.unifi.snapshot();
      if (viewers) {
        // Large, so other nodes get a pointer to the stored copy, not the payload itself.
        void this.realtime
          .toRoomSnapshot(ROOM, "network:snapshot", "unifi:network", snapshot)
          .catch((err: unknown) => this.logger.debug(`UniFi snapshot publish failed: ${(err as Error).message}`));
      }
      if (alertEnabled) await this.evaluateDeviceAlerts(snapshot);
      // Keep the search index's UniFi kinds current. Skip on an unreachable read
      // so a transient outage doesn't wipe the docs. Fire and forget — indexing
      // is best-effort and must never stall the poll loop.
      if (snapshot.health.reachable) {
        this.lastSearchSyncAt = Date.now();
        void this.search
          .syncUnifi(
            snapshot.devices as Parameters<SearchService["syncUnifi"]>[0],
            snapshot.clients as Parameters<SearchService["syncUnifi"]>[1],
          )
          .catch(() => undefined);
      }
    } catch (err) {
      this.logger.debug(`UniFi poll failed: ${(err as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  private async evaluateDeviceAlerts(snapshot: Awaited<ReturnType<UnifiService["snapshot"]>>): Promise<void> {
    // Don't treat a controller outage / empty read as "everything offline".
    if (!snapshot.health.reachable) return;

    const next = new Map<string, DeviceState>();
    for (const raw of snapshot.devices) {
      const d = raw as { mac?: string; name?: string; model?: string; state?: number };
      if (!d.mac) continue;
      next.set(d.mac, { online: d.state === 1, name: d.name || d.model || d.mac });
    }
    if (next.size === 0) return; // nothing usable this tick

    // The baseline lives in job_state, so it follows the job between nodes: read
    // it every pass rather than trusting memory, since another node may have led
    // (and alerted on transitions) since we last did. That also means a device
    // that went offline during a handover is alerted on, not silently absorbed.
    // In-memory state is only the fallback when the database is unreachable.
    const persisted = await this.loadBaseline();
    if (persisted) {
      this.deviceStates = persisted;
      this.seeded = true;
    }
    // First good read with no baseline anywhere establishes it; no alerts on it.
    if (!this.seeded) {
      this.deviceStates = next;
      this.seeded = true;
      await this.saveBaseline(next);
      return;
    }

    const wentOffline: string[] = [];
    const cameOnline: string[] = [];
    for (const [mac, cur] of next) {
      const prev = this.deviceStates.get(mac);
      if (!prev) continue; // newly-seen device — track, don't alert
      if (prev.online && !cur.online) wentOffline.push(cur.name);
      else if (!prev.online && cur.online) cameOnline.push(cur.name);
    }
    // Devices that vanished from the list are treated as removed (not offline).
    this.deviceStates = next;
    await this.saveBaseline(next);

    const jobs: Promise<void>[] = [];
    if (wentOffline.length > OFFLINE_ALERT_CAP) {
      jobs.push(
        this.fanOut("UniFi: multiple devices offline", `${wentOffline.length} UniFi devices went offline: ${wentOffline.slice(0, 15).join(", ")}…`),
      );
    } else {
      for (const name of wentOffline) jobs.push(this.fanOut(`UniFi device offline: ${name}`, `${name} went offline.`));
    }
    for (const name of cameOnline) jobs.push(this.fanOut(`UniFi device recovered: ${name}`, `${name} is back online.`));
    await Promise.all(jobs);
  }

  /** Only trust a baseline written within this long: older than that and alerting was likely off. */
  private static readonly BASELINE_MAX_AGE_MS = 5 * 60_000;

  private async loadBaseline(): Promise<Map<string, DeviceState> | null> {
    try {
      const row = await this.jobState.get<Record<string, DeviceState>>("unifi-poll", "devices");
      if (!row || row.ageMs > UnifiPoller.BASELINE_MAX_AGE_MS) return null;
      return new Map(Object.entries(row.value));
    } catch (err) {
      this.logger.debug(`UniFi baseline load failed: ${(err as Error).message}`);
      return null;
    }
  }

  private async saveBaseline(states: Map<string, DeviceState>): Promise<void> {
    try {
      await this.jobState.set("unifi-poll", "devices", Object.fromEntries(states));
    } catch (err) {
      this.logger.debug(`UniFi baseline save failed: ${(err as Error).message}`);
    }
  }

  private async fanOut(title: string, body: string): Promise<void> {
    try {
      // Maintenance mode silences the notification; device-state tracking above
      // continues so we don't mis-baseline when it's switched back off.
      if ((await this.settings.get("monitoring.maintenance_mode")) === true) return;
      const recipients = await this.infra.monitoringRecipientIds();
      if (!recipients.length) return;
      await this.notifications.createMany(
        recipients.map((id) => ({
          recipientUserId: id,
          kind: "unifi.device_offline",
          title,
          body,
          link: "/monitoring/network",
        })),
      );
    } catch (err) {
      this.logger.warn(`UniFi alert fan-out failed: ${(err as Error).message}`);
    }
  }
}
