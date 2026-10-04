import { Controller, Get, Post, Patch, Delete, Param, Query, Body, BadRequestException } from "@nestjs/common";
import {
  PERMISSIONS,
  DNS_STATS_RANGES,
  dnsTestSchema,
  dnsRecordCreateSchema,
  dnsRecordUpdateSchema,
  dnsRecordDeleteSchema,
  type DnsStatsRange,
} from "@church/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { Audited } from "../audit/audit.decorator";
import { DnsService } from "./dns.service";
import { DnsSearchIndexer } from "./dns.search-indexer";

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

  @Post("test")
  @RequirePermissions(WRITE)
  test(@Body() body: unknown) {
    const parsed = dnsTestSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.dns.testConnection(parsed.data);
  }
}
