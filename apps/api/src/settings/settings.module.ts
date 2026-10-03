import { Module, Global } from "@nestjs/common";
import { SettingsService } from "./settings.service";
import { SettingsController } from "./settings.controller";
import { SiteController } from "./site.controller";

@Global()
@Module({
  providers: [SettingsService],
  controllers: [SettingsController, SiteController],
  exports: [SettingsService],
})
export class SettingsModule {}
