import { Module } from "@nestjs/common";
import { SwitchModelsController } from "./switch-models.controller";
import { SwitchModelsService } from "./switch-models.service";

/** Switch models and their pictures for the switch view (Cisco now, UniFi next). DB and attachments are global. */
@Module({
  controllers: [SwitchModelsController],
  providers: [SwitchModelsService],
  exports: [SwitchModelsService],
})
export class SwitchModelsModule {}
