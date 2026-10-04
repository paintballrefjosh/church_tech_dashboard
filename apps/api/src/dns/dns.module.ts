import { Module } from "@nestjs/common";
import { DnsController } from "./dns.controller";
import { DnsService } from "./dns.service";
import { DnsSearchIndexer } from "./dns.search-indexer";
import { DnsSyncService } from "./dns.sync";

@Module({
  providers: [DnsService, DnsSearchIndexer, DnsSyncService],
  controllers: [DnsController],
  // DnsSyncService is used by the IPAM scanner/controller to trigger runs.
  exports: [DnsService, DnsSyncService],
})
export class DnsModule {}
