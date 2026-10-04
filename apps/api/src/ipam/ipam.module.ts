import { Module } from "@nestjs/common";
import { UnifiModule } from "../unifi/unifi.module";
import { DnsModule } from "../dns/dns.module";
import { IpamController } from "./ipam.controller";
import { IpamService } from "./ipam.service";
import { IpamScanner } from "./ipam.scanner";

/**
 * IPAM — the monitoring module's IPAM tab. A background scanner sweeps managed
 * subnets (added manually or discovered from Cisco config/ARP + UniFi) for live
 * hosts. DB + SettingsService are @Global; UnifiService comes from UnifiModule
 * (imported for its `networks()` discovery + client/device MAC map).
 */
@Module({
  // DnsModule: the scanner and IPAM edits trigger the IPAM -> DNS sync.
  imports: [UnifiModule, DnsModule],
  controllers: [IpamController],
  providers: [IpamService, IpamScanner],
  exports: [IpamService],
})
export class IpamModule {}
