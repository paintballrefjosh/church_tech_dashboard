import { Controller, Get, Post } from "@nestjs/common";
import { PERMISSIONS } from "@lampstand/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { SessionOnly } from "../auth/session-only.decorator";
import { Audited } from "../audit/audit.decorator";
import { TicketInbound } from "./ticket-inbound";

/** The helpdesk mailbox's status page and buttons. Tickets admins (and site admins): it reads a mailbox with a stored login, which the Tickets admin sets in Tickets > Settings. */
@Controller("tickets/inbound")
@SessionOnly()
export class TicketInboundController {
  constructor(private readonly inbound: TicketInbound) {}

  @Get("status")
  @RequirePermissions(PERMISSIONS.TICKETS_ADMIN)
  status() {
    return this.inbound.status();
  }

  @Post("test")
  @RequirePermissions(PERMISSIONS.TICKETS_ADMIN)
  @Audited({ action: "ticket.inbound.test", resourceType: "settings" })
  test() {
    return this.inbound.test();
  }

  @Post("check")
  @RequirePermissions(PERMISSIONS.TICKETS_ADMIN)
  @Audited({ action: "ticket.inbound.check", resourceType: "settings" })
  check() {
    return this.inbound.run({ force: true });
  }
}
