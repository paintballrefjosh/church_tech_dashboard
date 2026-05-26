import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  BadRequestException,
} from "@nestjs/common";
import {
  PERMISSIONS,
  createWikiPageSchema,
  updateWikiPageSchema,
  wikiPageListQuerySchema,
} from "@church/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { Audited } from "../audit/audit.decorator";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { WikiService } from "./wiki.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";

@Controller("wiki")
export class WikiController {
  constructor(
    private readonly wiki: WikiService,
    private readonly realtime: RealtimeGateway,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.WIKI_READ_OWN)
  async list(@CurrentUser() user: AuthenticatedUser, @Query() query: unknown) {
    const parsed = wikiPageListQuerySchema.safeParse(query ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.wiki.list(user, parsed.data);
  }

  @Get(":id")
  @RequirePermissions(PERMISSIONS.WIKI_READ_OWN)
  getOne(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.wiki.getWithAcl(user, id);
  }

  @Get(":id/revisions")
  @RequirePermissions(PERMISSIONS.WIKI_READ_OWN)
  revisions(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.wiki.revisions(user, id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.WIKI_CREATE)
  @Audited({ action: "wiki.create", resourceType: "wiki_page" })
  async create(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const parsed = createWikiPageSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const page = await this.wiki.create(user, parsed.data);
    this.realtime.toUser(user.id, "wiki:created", page);
    return page;
  }

  @Patch(":id")
  @RequirePermissions(PERMISSIONS.WIKI_READ_OWN)
  @Audited({
    action: "wiki.update",
    resourceType: "wiki_page",
    resourceIdFromParams: (p) => p.id ?? null,
  })
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const parsed = updateWikiPageSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const page = await this.wiki.update(user, id, parsed.data);
    this.realtime.toRoom(`wiki:${id}`, "wiki:updated", page);
    return page;
  }

  @Delete(":id")
  @RequirePermissions(PERMISSIONS.WIKI_READ_OWN)
  @Audited({
    action: "wiki.delete",
    resourceType: "wiki_page",
    resourceIdFromParams: (p) => p.id ?? null,
  })
  async remove(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    const out = await this.wiki.delete(user, id);
    this.realtime.toRoom(`wiki:${id}`, "wiki:deleted", { id });
    return out;
  }
}
