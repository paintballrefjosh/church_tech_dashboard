import { Module } from "@nestjs/common";
import { SwitchModelsController } from "./switch-models.controller";
import { SwitchModelsService } from "./switch-models.service";

/** Device profiles (table switch_models) and their pictures, for Cisco switches, infra hosts, UniFi devices and cabinets. DB and attachments are global. */
@Module({
  controllers: [SwitchModelsController],
  providers: [SwitchModelsService],
  exports: [SwitchModelsService],
})
export class SwitchModelsModule {}
