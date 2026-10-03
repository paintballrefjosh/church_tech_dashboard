import { Module } from "@nestjs/common";
import { TicketCategoriesController } from "./ticket-categories.controller";
import { TicketCategoriesService } from "./ticket-categories.service";
import { TicketsModule } from "../tickets/tickets.module";

@Module({
  imports: [TicketsModule],
  providers: [TicketCategoriesService],
  controllers: [TicketCategoriesController],
  exports: [TicketCategoriesService],
})
export class TicketCategoriesModule {}
