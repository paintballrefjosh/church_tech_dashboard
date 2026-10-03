import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  Body,
  BadRequestException,
} from "@nestjs/common";
import {
  PERMISSIONS,
  createTicketCategorySchema,
  updateTicketCategorySchema,
  setTicketCategoriesSchema,
} from "@church/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { Audited } from "../audit/audit.decorator";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { TicketCategoriesService } from "./ticket-categories.service";
import { TicketsService } from "../tickets/tickets.service";

@Controller("ticket-categories")
export class TicketCategoriesController {
  constructor(
    private readonly categories: TicketCategoriesService,
    private readonly tickets: TicketsService,
  ) {}

  // ---- catalogue ----

  @Get()
  // Catalogue is readable by anyone who can read at least their own tickets —
  // the picker on the new-ticket / ticket-detail pages needs the full list.
  @RequirePermissions(PERMISSIONS.TICKETS_READ_OWN)
  list() {
    return this.categories.list();
  }

  @Post()
  @RequirePermissions(PERMISSIONS.TICKETS_CATEGORIES_ADMIN)
  @Audited({ action: "ticket_category.create", resourceType: "ticket_category" })
  async create(@Body() body: unknown) {
    const parsed = createTicketCategorySchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.categories.create(parsed.data);
  }

  @Patch(":id")
  @RequirePermissions(PERMISSIONS.TICKETS_CATEGORIES_ADMIN)
  @Audited({
    action: "ticket_category.update",
    resourceType: "ticket_category",
    resourceIdFromParams: (p) => p.id ?? null,
  })
  async update(@Param("id") id: string, @Body() body: unknown) {
    const parsed = updateTicketCategorySchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.categories.update(id, parsed.data);
  }

  @Delete(":id")
  @RequirePermissions(PERMISSIONS.TICKETS_CATEGORIES_ADMIN)
  @Audited({
    action: "ticket_category.delete",
    resourceType: "ticket_category",
    resourceIdFromParams: (p) => p.id ?? null,
  })
  remove(@Param("id") id: string) {
    return this.categories.delete(id);
  }

  // ---- per-ticket assignment ----
  // Authorisation here defers to the underlying ticket: anyone who can edit a
  // ticket can categorise it. No category-write permission required.

  @Get("for/:ticketId")
  @RequirePermissions(PERMISSIONS.TICKETS_READ_OWN)
  async forTicket(
    @CurrentUser() user: AuthenticatedUser,
    @Param("ticketId") ticketId: string,
  ) {
    await this.tickets.assertReadable(user, ticketId);
    return this.categories.forTicket(ticketId);
  }

  @Put("for/:ticketId")
  @RequirePermissions(PERMISSIONS.TICKETS_READ_OWN)
  @Audited({
    action: "ticket_category.assign",
    resourceType: "ticket",
    resourceIdFromParams: (p) => p.ticketId ?? null,
  })
  async setForTicket(
    @CurrentUser() user: AuthenticatedUser,
    @Param("ticketId") ticketId: string,
    @Body() body: unknown,
  ) {
    await this.tickets.assertWritable(user, ticketId);
    const parsed = setTicketCategoriesSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const before = (await this.categories.forTicket(ticketId)).map((c) => c.name);
    const after = await this.categories.setForTicket(ticketId, parsed.data.categoryIds);
    await this.tickets.logSetChange(ticketId, user, "changed categories", before, after.map((c) => c.name));
    return after;
  }
}
