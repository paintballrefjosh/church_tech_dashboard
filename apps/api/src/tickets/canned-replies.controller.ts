import { BadRequestException, Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { PERMISSIONS, createCannedReplySchema, updateCannedReplySchema } from "@church/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { Audited } from "../audit/audit.decorator";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { CannedRepliesService } from "./canned-replies.service";

/** Saved answers for the ticket comment box. Anyone who works the queue can use them; changing them takes ticket admin. */
@Controller("tickets/canned-replies")
export class CannedRepliesController {
  constructor(private readonly replies: CannedRepliesService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.TICKETS_READ_ANY)
  list() {
    return this.replies.list();
  }

  @Post()
  @RequirePermissions(PERMISSIONS.TICKETS_ADMIN)
  @Audited({ action: "ticket.canned_reply.create", resourceType: "ticket_canned_reply" })
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const parsed = createCannedReplySchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.replies.create(user.id, parsed.data);
  }

  @Patch(":id")
  @RequirePermissions(PERMISSIONS.TICKETS_ADMIN)
  @Audited({ action: "ticket.canned_reply.update", resourceType: "ticket_canned_reply", resourceIdFromParams: (p) => p.id ?? null })
  update(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const parsed = updateCannedReplySchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.replies.update(id, parsed.data);
  }

  @Delete(":id")
  @RequirePermissions(PERMISSIONS.TICKETS_ADMIN)
  @Audited({ action: "ticket.canned_reply.delete", resourceType: "ticket_canned_reply", resourceIdFromParams: (p) => p.id ?? null })
  remove(@Param("id", ParseUUIDPipe) id: string) {
    return this.replies.remove(id);
  }
}
