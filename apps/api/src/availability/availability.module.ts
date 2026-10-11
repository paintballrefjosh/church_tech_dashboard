import { Module } from "@nestjs/common";
import { UnifiModule } from "../unifi/unifi.module";
import { DnsModule } from "../dns/dns.module";
import { AvailabilityStore } from "./availability.store";
import { AvailabilitySampler } from "./availability.sampler";
import { AVAILABILITY_SOURCES, DefaultAvailabilitySources } from "./availability.sources";

@Module({
  imports: [UnifiModule, DnsModule],
  providers: [
    AvailabilityStore,
    { provide: AVAILABILITY_SOURCES, useClass: DefaultAvailabilitySources },
    AvailabilitySampler,
  ],
  exports: [AvailabilityStore, AvailabilitySampler],
})
export class AvailabilityModule {}
