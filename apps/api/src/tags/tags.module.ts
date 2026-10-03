import { Module, Global } from "@nestjs/common";
import { TagsController } from "./tags.controller";
import { TagsService } from "./tags.service";
import { TicketsModule } from "../tickets/tickets.module";

@Global()
@Module({
  imports: [TicketsModule],
  providers: [TagsService],
  controllers: [TagsController],
  exports: [TagsService],
})
export class TagsModule {}
