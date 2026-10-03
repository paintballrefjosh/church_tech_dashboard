import { Module } from "@nestjs/common";
import { ChecklistsController } from "./checklists.controller";
import { ChecklistsService } from "./checklists.service";
import { ChecklistScheduler } from "./checklist.scheduler";
import { PlanningCenterModule } from "../planning-center/planning-center.module";

@Module({
  imports: [PlanningCenterModule],
  controllers: [ChecklistsController],
  providers: [ChecklistsService, ChecklistScheduler],
})
export class ChecklistsModule {}
