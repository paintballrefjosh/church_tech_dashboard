import { Controller, Get, Post, Param, Query, Body, BadRequestException } from "@nestjs/common";
import { PERMISSIONS, DNS_STATS_RANGES, dnsTestSchema, type DnsStatsRange } from "@church/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { DnsService } from "./dns.service";

/**
 * DNS API for the monitoring module's DNS tab. Reuses the monitoring
 * permissions like cisco/ipam/ups: reads need monitors:read:any, and the
 * connection test (which can probe arbitrary URLs) needs monitors:write:any,
 * the same permission that gates the monitoring settings page it lives on.
 * Phase 1 is read-only; nothing here mutates state, so nothing is audited.
 */
const READ = PERMISSIONS.MONITORS_READ_ANY;
const WRITE = PERMISSIONS.MONITORS_WRITE_ANY;

@Controller("dns")
export class DnsController {
  constructor(private readonly dns: DnsService) {}

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
