import { Module } from "@nestjs/common";
import { UpsController } from "./ups.controller";
import { UpsService } from "./ups.service";

@Module({
  providers: [UpsService],
  controllers: [UpsController],
  exports: [UpsService],
})
export class UpsModule {}
