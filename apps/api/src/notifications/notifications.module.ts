import { Module, Global } from "@nestjs/common";
import { NotificationsController } from "./notifications.controller";
import { NotificationSettingsController } from "./notification-settings.controller";
import { NotificationsService } from "./notifications.service";
import { NotificationDeliveryService } from "./notification-delivery.service";
import { NotificationRelease } from "./notification-release";
import { PushService } from "./push.service";
import { RealtimeModule } from "../realtime/realtime.module";

@Global()
@Module({
  imports: [RealtimeModule],
  controllers: [NotificationsController, NotificationSettingsController],
  providers: [NotificationsService, NotificationDeliveryService, NotificationRelease, PushService],
  exports: [NotificationsService, NotificationDeliveryService, PushService],
})
export class NotificationsModule {}
