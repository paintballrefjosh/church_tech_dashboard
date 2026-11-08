import { Module } from "@nestjs/common";
import { SignageController } from "./signage.controller";
import { SignageService } from "./signage.service";
import { SignageCompiler } from "./compiler.service";
import { SignageMediaService } from "./media.service";

/** Signage (docs/signage.md). DB, settings, notifications, rooms and cluster jobs come from global modules. */
@Module({
  controllers: [SignageController],
  providers: [SignageService, SignageCompiler, SignageMediaService],
  exports: [SignageService, SignageCompiler, SignageMediaService],
})
export class SignageModule {}
