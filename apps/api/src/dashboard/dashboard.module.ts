import { Module } from "@nestjs/common";
import { DashboardController } from "./dashboard.controller";
import { DashboardService } from "./dashboard.service";
import { HomeController } from "./home/home.controller";
import { HomeService } from "./home/home.service";
import { HOME_SECTION_PROVIDERS } from "./home/sections";
import { TicketsModule } from "../tickets/tickets.module";
import { ChecklistsModule } from "../checklists/checklists.module";
import { PlanningCenterModule } from "../planning-center/planning-center.module";
import { MonitorsModule } from "../monitors/monitors.module";
import { InfraModule } from "../infra/infra.module";
import { UnifiModule } from "../unifi/unifi.module";
import { CiscoModule } from "../cisco/cisco.module";
import { DnsModule } from "../dns/dns.module";
import { WikiModule } from "../wiki/wiki.module";
import { NotesModule } from "../notes/notes.module";
import { ActivityModule } from "../activity/activity.module";
import { AvailabilityModule } from "../availability/availability.module";

/**
 * A leaf module: nothing imports it except AppModule. The imports below are the services the
 * home snapshot's section builders read from (SettingsService is global).
 */
@Module({
  imports: [
    TicketsModule,
    ChecklistsModule,
    PlanningCenterModule,
    MonitorsModule,
    InfraModule,
    UnifiModule,
    CiscoModule,
    DnsModule,
    WikiModule,
    NotesModule,
    ActivityModule,
    AvailabilityModule,
  ],
  controllers: [DashboardController, HomeController],
  providers: [DashboardService, HomeService, ...HOME_SECTION_PROVIDERS],
})
export class DashboardModule {}
