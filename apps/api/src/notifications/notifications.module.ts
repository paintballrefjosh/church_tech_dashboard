import { Module, Global } from "@nestjs/common";
import { NotificationsController } from "./notifications.controller";
import { NotificationsService } from "./notifications.service";
import { RealtimeModule } from "../realtime/realtime.module";

@Global()
@Module({
  imports: [RealtimeModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
