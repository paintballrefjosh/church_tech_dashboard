import { Module, Global } from "@nestjs/common";
import { InfraController } from "./infra.controller";
import { InfraService } from "./infra.service";
import { InfraCollector } from "./infra-collector";
import { InfraTester } from "./infra-tester";
import { InfraUpdaterService } from "./infra-updater";
import { RealtimeModule } from "../realtime/realtime.module";

/**
 * Infrastructure monitoring: agentless collection (SSH / Proxmox API / Docker
 * over SSH) into a time-series store, with threshold alerts reusing the
 * monitor_incidents + notifications + activity plumbing. The collector is an
 * in-process poller (like MonitorsProber / PrintersService); NotificationsService,
 * ActivityService and SettingsService are @Global so no imports are needed.
 */
@Global()
@Module({
  imports: [RealtimeModule],
  controllers: [InfraController],
  providers: [InfraService, InfraCollector, InfraTester, InfraUpdaterService],
  exports: [InfraService],
})
export class InfraModule {}
