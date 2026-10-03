import { Module, Global } from "@nestjs/common";
import { MonitorsController } from "./monitors.controller";
import { MonitorsService } from "./monitors.service";

/**
 * Probing itself lives entirely in the dedicated `services/monitor` worker
 * (see CLAUDE.md architecture) — this module is CRUD + read only. It used to
 * also run an in-process `MonitorsProber` as a duplicate probe engine; that
 * was removed (2026-09-18) because it raced the dedicated worker on the same
 * `monitors`/`monitor_checks`/`monitor_incidents` rows with no coordination,
 * causing lost updates (incidents stuck open with no recovery notification)
 * and its own crude TCP:80 "ICMP fallback" produced false-down alerts
 * ("tcp-fallback ... ECONNREFUSED") on hosts with nothing listening on port
 * 80, racing against the dedicated worker's real ICMP probe on the same
 * target.
 */
@Global()
@Module({
  controllers: [MonitorsController],
  providers: [MonitorsService],
  exports: [MonitorsService],
})
export class MonitorsModule {}
