import { Module } from "@nestjs/common";
import { DnsController } from "./dns.controller";
import { DnsService } from "./dns.service";
import { DnsSearchIndexer } from "./dns.search-indexer";

@Module({
  providers: [DnsService, DnsSearchIndexer],
  controllers: [DnsController],
  exports: [DnsService],
})
export class DnsModule {}
