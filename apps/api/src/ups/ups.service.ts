import {
  Injectable,
  Inject,
  NotFoundException,
  Logger,
  type OnModuleInit,
} from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { upsDevices } from "../db/schema";
import { SettingsService } from "../settings/settings.service";
import { ClusterJobs } from "../cluster/cluster-jobs.service";
import type {
  CreateUpsInput,
  UpdateUpsInput,
  Ups,
  UpsStatus,
  UpsSummary,
  UpsBatteryState,
  UpsOutputSource,
} from "@church/shared";
import { probeUpsSnmp } from "./snmp";

// Bootstrap-time fallbacks if no settings rows exist yet.
const FALLBACK_SNMP_VERSION = "v2c";
const FALLBACK_SNMP_COMMUNITY = "public";
const FALLBACK_SNMP_TIMEOUT_MS = 3000;
const FALLBACK_POLL_INTERVAL_MIN = 5;

@Injectable()
export class UpsService implements OnModuleInit {
  private readonly logger = new Logger(UpsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly jobs: ClusterJobs,
  ) {}

  // ---- lifecycle: background poller ----

  async onModuleInit(): Promise<void> {
    const minutes = await this.getNumberSetting(
      "monitoring.ups_poll_interval_min",
      FALLBACK_POLL_INTERVAL_MIN,
    );
    // Skip the first 30s after boot so we don't block the readiness probe.
    // A cluster job, so only one node polls at a time.
    this.jobs.register({
      name: "ups-poll",
      everyMs: Math.max(60_000, minutes * 60_000),
      initialDelayMs: 30_000,
      run: () => this.pollAll(),
    });
  }

  // ---- CRUD ----

  async list(): Promise<Ups[]> {
    const rows = await this.db.select().from(upsDevices);
    return rows.map(toUps);
  }

  async getById(id: string): Promise<Ups> {
    const [row] = await this.db.select().from(upsDevices).where(eq(upsDevices.id, id)).limit(1);
    if (!row) throw new NotFoundException("UPS not found");
    return toUps(row);
  }

  async create(input: CreateUpsInput): Promise<Ups> {
    const [row] = await this.db
      .insert(upsDevices)
      .values({
        name: input.name.trim(),
        host: input.host.trim(),
        snmpPort: input.snmpPort,
        snmpVersion: input.snmpVersion,
        snmpCommunity: input.snmpCommunity,
        notes: input.notes ?? null,
      })
      .returning();
    if (!row) throw new Error("Insert failed");
    return toUps(row);
  }

  async update(id: string, input: UpdateUpsInput): Promise<Ups> {
    await this.getById(id);
    const patch: Partial<typeof upsDevices.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.host !== undefined) patch.host = input.host.trim();
    if (input.snmpPort !== undefined) patch.snmpPort = input.snmpPort;
    if (input.snmpVersion !== undefined) patch.snmpVersion = input.snmpVersion;
    if (input.snmpCommunity !== undefined) patch.snmpCommunity = input.snmpCommunity;
    if (input.notes !== undefined) patch.notes = input.notes;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    const [row] = await this.db.update(upsDevices).set(patch).where(eq(upsDevices.id, id)).returning();
    return toUps(row!);
  }

  async delete(id: string): Promise<{ ok: true }> {
    const [row] = await this.db.delete(upsDevices).where(eq(upsDevices.id, id)).returning();
    if (!row) throw new NotFoundException("UPS not found");
    return { ok: true };
  }

  async summary(): Promise<UpsSummary> {
    const rows = await this.db
      .select({ status: upsDevices.lastStatus, count: sql<number>`count(*)::int` })
      .from(upsDevices)
      .groupBy(upsDevices.lastStatus);
    const out: UpsSummary = { green: 0, yellow: 0, red: 0, unknown: 0, total: 0 };
    for (const r of rows) {
      const c = Number(r.count) || 0;
      out.total += c;
      if (r.status === "green" || r.status === "yellow" || r.status === "red" || r.status === "unknown") {
        out[r.status] += c;
      }
    }
    return out;
  }

  // ---- polling ----

  async pollOne(id: string): Promise<Ups> {
    const ups = await this.getById(id);
    if (!ups.enabled) return ups; // don't probe disabled devices

    const result = await probeUpsSnmp(await this.connectionFor(ups));

    const [row] = await this.db
      .update(upsDevices)
      .set({
        lastStatus: result.status,
        lastCheckedAt: new Date(),
        lastError: result.error ?? null,
        batteryPct: result.batteryPct,
        runtimeMin: result.runtimeMin,
        loadPct: result.loadPct,
        inputVoltage: result.inputVoltage,
        outputVoltage: result.outputVoltage,
        batteryState: result.batteryState,
        outputSource: result.outputSource,
        updatedAt: new Date(),
      })
      .where(eq(upsDevices.id, id))
      .returning();
    return toUps(row!);
  }

  async pollAll(): Promise<void> {
    const rows = await this.db.select({ id: upsDevices.id }).from(upsDevices).where(eq(upsDevices.enabled, true));
    const limit = 5;
    let idx = 0;
    const workers = Array.from({ length: Math.min(limit, rows.length) }, async () => {
      while (idx < rows.length) {
        const target = rows[idx++]!;
        try {
          await this.pollOne(target.id);
        } catch (err) {
          this.logger.warn(`pollOne(${target.id}) failed: ${(err as Error).message}`);
        }
      }
    });
    await Promise.all(workers);
  }

  /**
   * Ad-hoc SNMP probe for the UPS Add/Edit dialog's "Test connection" button.
   * Uses supplied values, filling blanks from the monitoring.ups_* defaults.
   */
  async testConnection(opts: {
    host: string;
    port?: number;
    version?: "v1" | "v2c";
    community?: string;
    timeoutMs?: number;
  }): Promise<{
    ok: boolean;
    message: string;
    status?: string;
    batteryPct?: number | null;
    runtimeMin?: number | null;
  }> {
    if (!opts.host?.trim()) return { ok: false, message: "Host is required" };
    const community =
      opts.community?.trim() ||
      (await this.getStringSetting("monitoring.ups_default_snmp_community", FALLBACK_SNMP_COMMUNITY));
    const defaultVersion = await this.getStringSetting(
      "monitoring.ups_default_snmp_version",
      FALLBACK_SNMP_VERSION,
    );
    const version = (opts.version ?? (defaultVersion === "v1" ? "v1" : "v2c")) as "v1" | "v2c";
    const timeoutMs =
      opts.timeoutMs ??
      (await this.getNumberSetting("monitoring.ups_snmp_timeout_ms", FALLBACK_SNMP_TIMEOUT_MS));

    const result = await probeUpsSnmp({
      host: opts.host.trim(),
      port: opts.port ?? 161,
      community,
      version,
      timeoutMs,
    });
    if (result.error) {
      return { ok: false, message: `SNMP probe failed: ${result.error}` };
    }
    return {
      ok: true,
      message: `Reached ${opts.host} over SNMP ${version} (status ${result.status})`,
      status: result.status,
      batteryPct: result.batteryPct,
      runtimeMin: result.runtimeMin,
    };
  }

  // ---- helpers ----

  private async connectionFor(ups: Ups): Promise<{
    host: string;
    port: number;
    version: "v1" | "v2c";
    community: string;
    timeoutMs: number;
  }> {
    const community =
      ups.snmpCommunity ??
      (await this.getStringSetting("monitoring.ups_default_snmp_community", FALLBACK_SNMP_COMMUNITY));
    const versionRaw =
      ups.snmpVersion ??
      (await this.getStringSetting("monitoring.ups_default_snmp_version", FALLBACK_SNMP_VERSION));
    const timeoutMs = await this.getNumberSetting(
      "monitoring.ups_snmp_timeout_ms",
      FALLBACK_SNMP_TIMEOUT_MS,
    );
    return {
      host: ups.host,
      port: ups.snmpPort,
      community,
      version: versionRaw === "v1" ? "v1" : "v2c",
      timeoutMs,
    };
  }

  private async getStringSetting(key: string, fallback: string): Promise<string> {
    const raw = await this.settings.get(key);
    return typeof raw === "string" && raw.length > 0 ? raw : fallback;
  }

  private async getNumberSetting(key: string, fallback: number): Promise<number> {
    const raw = await this.settings.get(key);
    return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
  }
}

function toUps(row: typeof upsDevices.$inferSelect): Ups {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    snmpPort: row.snmpPort,
    snmpVersion: (row.snmpVersion as Ups["snmpVersion"]) ?? null,
    snmpCommunity: row.snmpCommunity ?? null,
    enabled: row.enabled,
    notes: row.notes ?? null,
    lastStatus: row.lastStatus as UpsStatus,
    lastCheckedAt: row.lastCheckedAt ? row.lastCheckedAt.toISOString() : null,
    lastError: row.lastError ?? null,
    batteryPct: row.batteryPct ?? null,
    runtimeMin: row.runtimeMin ?? null,
    loadPct: row.loadPct ?? null,
    inputVoltage: row.inputVoltage ?? null,
    outputVoltage: row.outputVoltage ?? null,
    batteryState: row.batteryState as UpsBatteryState,
    outputSource: row.outputSource as UpsOutputSource,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
