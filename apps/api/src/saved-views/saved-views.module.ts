import { Module } from "@nestjs/common";
import { SavedViewsService } from "./saved-views.service";
import { SavedViewsController } from "./saved-views.controller";

@Module({
  providers: [SavedViewsService],
  controllers: [SavedViewsController],
})
export class SavedViewsModule {}
