import { Module } from "@nestjs/common";
import { AlertsController } from "./alerts.controller";
import { AlertChannelsService } from "./alert-channels.service";
import { AlertDispatch } from "./alert-dispatch";

/**
 * Alert channels and the outbox that feeds them (and the bell/email/push for the probe worker's alerts). DB, settings,
 * notifications, infra and cluster jobs come from global modules.
 */
@Module({
  controllers: [AlertsController],
  providers: [AlertChannelsService, AlertDispatch],
  exports: [AlertChannelsService],
})
export class AlertsModule {}
