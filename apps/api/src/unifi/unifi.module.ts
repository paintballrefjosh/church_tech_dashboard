import { Module } from "@nestjs/common";
import { UnifiController } from "./unifi.controller";
import { UnifiService } from "./unifi.service";
import { UnifiPoller } from "./unifi.poller";
import { RealtimeModule } from "../realtime/realtime.module";

@Module({
  imports: [RealtimeModule],
  controllers: [UnifiController],
  providers: [UnifiService, UnifiPoller],
  exports: [UnifiService],
})
export class UnifiModule {}
