import { Module } from "@nestjs/common";
import { RealtimeModule } from "../realtime/realtime.module";
import { ServiceMonitoringController } from "./service-monitoring.controller";
import { ServiceMonitoringService } from "./service-monitoring.service";
import { ServicePoller } from "./service-poller";
import { ServiceGroupsService } from "./service-groups.service";

/**
 * Service monitoring templates on infra hosts (docs/service-monitoring.md). DB, settings, notifications, activity,
 * infra (recipients, the collector's discovery) and cluster jobs come from global modules.
 */
@Module({ imports: [RealtimeModule], controllers: [ServiceMonitoringController], providers: [ServiceMonitoringService, ServicePoller, ServiceGroupsService], exports: [ServiceMonitoringService, ServiceGroupsService] })
export class ServiceMonitoringModule {}
