import { Body, Controller, Delete, Get, Param, Post, Put, Query, BadRequestException } from "@nestjs/common";
import { z } from "zod";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { Audited } from "../audit/audit.decorator";
import { SavedViewsService, isSavedViewResource } from "./saved-views.service";

const resourceSchema = z.enum(["ticket", "wiki_page", "note"]);
const querySchema = z.record(z.string().max(256));

const createBody = z.object({
  resourceType: resourceSchema,
  name: z.string().min(1).max(120),
  query: querySchema,
});

const updateBody = z.object({
  name: z.string().min(1).max(120).optional(),
  query: querySchema.optional(),
});

@Controller("saved-views")
export class SavedViewsController {
  constructor(private readonly views: SavedViewsService) {}

  /** GET /saved-views?resource=ticket — list this user's saved views for that list. */
  @Get()
  async list(@CurrentUser() user: AuthenticatedUser, @Query("resource") resource: string) {
    if (!resource || !isSavedViewResource(resource)) {
      throw new BadRequestException("resource query param required (ticket|wiki_page|note)");
    }
    return this.views.list(user.id, resource);
  }

  @Post()
  @Audited({ action: "saved_view.create", resourceType: "saved_view" })
  async create(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const parsed = createBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.views.create(user.id, parsed.data);
  }

  @Put(":id")
  @Audited({ action: "saved_view.update", resourceType: "saved_view", resourceIdFromParams: (p) => p.id ?? null })
  async update(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() body: unknown) {
    const parsed = updateBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.views.update(user.id, id, parsed.data);
  }

  @Delete(":id")
  @Audited({ action: "saved_view.delete", resourceType: "saved_view", resourceIdFromParams: (p) => p.id ?? null })
  async remove(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.views.delete(user.id, id);
  }
}
