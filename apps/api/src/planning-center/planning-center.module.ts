import { Module } from "@nestjs/common";
import { PlanningCenterController } from "./planning-center.controller";
import { PlanningCenterService } from "./planning-center.service";

@Module({
  controllers: [PlanningCenterController],
  providers: [PlanningCenterService],
  exports: [PlanningCenterService],
})
export class PlanningCenterModule {}
