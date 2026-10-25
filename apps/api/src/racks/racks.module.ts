import { Module } from "@nestjs/common";
import { CiscoModule } from "../cisco/cisco.module";
import { UnifiModule } from "../unifi/unifi.module";
import { RacksController, PortSheetsController } from "./racks.controller";
import { RacksService } from "./racks.service";
import { PortSheetsService } from "./port-sheets.service";

/**
 * Cabinets (racks): where devices sit, as an elevation, and the printable pages built from it; plus the port sheets
 * for a Cisco or UniFi switch. DB is global; Cisco and UniFi come from their modules (read-only use).
 */
@Module({
  imports: [CiscoModule, UnifiModule],
  controllers: [RacksController, PortSheetsController],
  providers: [RacksService, PortSheetsService],
})
export class RacksModule {}
