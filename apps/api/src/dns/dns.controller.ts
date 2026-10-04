import { Controller, Get, Post, Patch, Delete, Param, Query, Body, BadRequestException } from "@nestjs/common";
import {
  PERMISSIONS,
  DNS_STATS_RANGES,
  dnsTestSchema,
  dnsRecordCreateSchema,
  dnsRecordUpdateSchema,
  dnsRecordDeleteSchema,
  dnsSyncRunSchema,
  dnsReverseZoneCreateSchema,
  type DnsStatsRange,
} from "@church/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { Audited } from "../audit/audit.decorator";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { DnsService } from "./dns.service";
import { DnsSearchIndexer } from "./dns.search-indexer";
import { DnsSyncService } from "./dns.sync";

/**
 * DNS API for the monitoring module's DNS tab. Reuses the monitoring
 * permissions like cisco/ipam/ups: reads need monitors:read:any; record writes
 * and the connection test (which can probe arbitrary URLs) need
 * monitors:write:any. Record writes are audited with a before/after snapshot
 * (the response carries both). Records are addressed by zone + name + data in
 * the body because Technitium records have no id.
 */
const READ = PERMISSIONS.MONITORS_READ_ANY;
const WRITE = PERMISSIONS.MONITORS_WRITE_ANY;

@Controller("dns")
export class DnsController {
  constructor(
    private readonly dns: DnsService,
    private readonly indexer: DnsSearchIndexer,
    private readonly sync: DnsSyncService,
  ) {}

  @Get("summary")
  @RequirePermissions(READ)
  summary() {
    return this.dns.summary();
  }

  @Get("zones")
  @RequirePermissions(READ)
  zones() {
    return this.dns.zones();
  }

  @Get("zones/:zone/records")
  @RequirePermissions(READ)
  records(@Param("zone") zone: string) {
    return this.dns.records(zone);
  }

  @Post("zones/:zone/records")
  @RequirePermissions(WRITE)
  @Audited({ action: "dns.record.create", resourceType: "dns_record" })
  async createRecord(@Param("zone") zone: string, @Body() body: unknown) {
    const parsed = dnsRecordCreateSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const res = await this.dns.createRecord(zone, parsed.data);
    this.indexer.requestSync();
    return res;
  }

  @Patch("zones/:zone/records")
  @RequirePermissions(WRITE)
  @Audited({ action: "dns.record.update", resourceType: "dns_record" })
  async updateRecord(@Param("zone") zone: string, @Body() body: unknown) {
    const parsed = dnsRecordUpdateSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const res = await this.dns.updateRecord(zone, parsed.data);
    this.indexer.requestSync();
    return res;
  }

  @Delete("zones/:zone/records")
  @RequirePermissions(WRITE)
  @Audited({ action: "dns.record.delete", resourceType: "dns_record" })
  async deleteRecord(@Param("zone") zone: string, @Body() body: unknown) {
    const parsed = dnsRecordDeleteSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const res = await this.dns.deleteRecord(zone, parsed.data);
    this.indexer.requestSync();
    return res;
  }

  @Get("stats")
  @RequirePermissions(READ)
  stats(@Query("range") range?: string) {
    const r = (range ?? "LastDay") as DnsStatsRange;
    if (!DNS_STATS_RANGES.includes(r)) {
      throw new BadRequestException(`range must be one of ${DNS_STATS_RANGES.join(", ")}`);
    }
    return this.dns.stats(r);
  }

  // ---- IPAM -> DNS sync ----

  /** What a sync would do right now (works while sync is off). */
  @Get("sync/plan")
  @RequirePermissions(READ)
  syncPlan() {
    return this.sync.plan();
  }

  @Get("sync/status")
  @RequirePermissions(READ)
  syncStatus() {
    return this.sync.status();
  }

  @Get("sync/runs")
  @RequirePermissions(READ)
  syncRuns() {
    return this.sync.runs();
  }

  @Get("sync/managed")
  @RequirePermissions(READ)
  syncManaged() {
    return this.sync.managed();
  }

  @Post("sync")
  @RequirePermissions(WRITE)
  @Audited({ action: "dns.sync.run", resourceType: "dns_sync_run" })
  runSync(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    const parsed = dnsSyncRunSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.sync.run("manual", user?.id ?? null, parsed.data.force);
  }

  /** Strip the managed-by marker so the record becomes hand-owned. */
  @Post("managed/:id/release")
  @RequirePermissions(WRITE)
  @Audited({ action: "dns.managed.release", resourceType: "dns_record" })
  async release(@Param("id") id: string) {
    const res = await this.sync.release(id);
    this.indexer.requestSync();
    return res;
  }

  @Post("reverse-zones")
  @RequirePermissions(WRITE)
  @Audited({ action: "dns.zone.create", resourceType: "dns_zone" })
  createReverseZone(@Body() body: unknown) {
    const parsed = dnsReverseZoneCreateSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.sync.createReverseZone(parsed.data.zone);
  }

  @Post("test")
  @RequirePermissions(WRITE)
  test(@Body() body: unknown) {
    const parsed = dnsTestSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.dns.testConnection(parsed.data);
  }
}
