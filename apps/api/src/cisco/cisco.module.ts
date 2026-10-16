import { Module } from "@nestjs/common";
import { CiscoController } from "./cisco.controller";
import { CiscoService } from "./cisco.service";
import { CiscoPoller } from "./cisco.poller";
import { CiscoVlansService } from "./cisco-vlans.service";

/**
 * Cisco switch management — SSH poller (config backups, drift, L2 caches) +
 * REST API. Ported from the standalone cisco-switch app into the monitoring
 * module's Network (Cisco) tab. SettingsService/DB are global so no imports.
 */
@Module({
  controllers: [CiscoController],
  providers: [CiscoService, CiscoVlansService, CiscoPoller],
  exports: [CiscoService, CiscoVlansService],
})
export class CiscoModule {}
