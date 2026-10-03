import { Module } from "@nestjs/common";
import { DnsController } from "./dns.controller";
import { DnsService } from "./dns.service";

@Module({
  providers: [DnsService],
  controllers: [DnsController],
  exports: [DnsService],
})
export class DnsModule {}
