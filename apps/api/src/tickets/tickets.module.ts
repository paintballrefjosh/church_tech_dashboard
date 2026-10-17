import { Module } from "@nestjs/common";
import { TicketsController } from "./tickets.controller";
import { CannedRepliesController } from "./canned-replies.controller";
import { TicketsService } from "./tickets.service";
import { CannedRepliesService } from "./canned-replies.service";
import { TicketSla } from "./ticket-sla";
import { TicketEvents } from "./ticket-events";
import { TicketInbound } from "./ticket-inbound";
import { TicketInboundController } from "./ticket-inbound.controller";
import { RealtimeModule } from "../realtime/realtime.module";

@Module({
  imports: [RealtimeModule],
  controllers: [TicketsController, CannedRepliesController, TicketInboundController],
  providers: [TicketsService, CannedRepliesService, TicketSla, TicketEvents, TicketInbound],
  exports: [TicketsService],
})
export class TicketsModule {}
