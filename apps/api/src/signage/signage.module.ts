import { Module } from "@nestjs/common";
import { UnifiModule } from "../unifi/unifi.module";
import { SignageController } from "./signage.controller";
import { SignageDevicesController, SignageSummaryController } from "./devices.controller";
import { SignageService } from "./signage.service";
import { SignageCompiler } from "./compiler.service";
import { SignageMediaService } from "./media.service";
import { SignageDevices } from "./devices.service";
import { SignageDiscovery } from "./discovery.service";
import { SignageSetup } from "./setup.service";
import { SignageSync } from "./sync.service";
import { SignagePoller } from "./poller.service";
import { SignageReleases } from "./releases.service";

/** Signage (docs/signage.md). DB, settings, notifications, rooms and cluster jobs come from global modules. */
@Module({
  imports: [UnifiModule],
  controllers: [SignageController, SignageDevicesController, SignageSummaryController],
  providers: [SignageService, SignageCompiler, SignageMediaService, SignageDevices, SignageDiscovery, SignageSetup, SignageSync, SignagePoller, SignageReleases],
  exports: [SignageService, SignageCompiler, SignageMediaService, SignageDevices, SignageDiscovery],
})
export class SignageModule {}
