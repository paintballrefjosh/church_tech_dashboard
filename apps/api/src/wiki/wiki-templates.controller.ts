import { BadRequestException, Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { PERMISSIONS, createWikiTemplateSchema, updateWikiTemplateSchema } from "@church/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { Audited } from "../audit/audit.decorator";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { WikiTemplatesService } from "./wiki-templates.service";

/** Page templates. Anyone who can read the wiki can start a page from one; keeping them takes wiki admin. */
@Controller("wiki/templates")
export class WikiTemplatesController {
  constructor(private readonly templates: WikiTemplatesService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.WIKI_READ_OWN)
  list() {
    return this.templates.list();
  }

  @Post()
  @RequirePermissions(PERMISSIONS.WIKI_ADMIN)
  @Audited({ action: "wiki.template.create", resourceType: "wiki_template" })
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const parsed = createWikiTemplateSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.templates.create(user.id, parsed.data);
  }

  @Patch(":id")
  @RequirePermissions(PERMISSIONS.WIKI_ADMIN)
  @Audited({ action: "wiki.template.update", resourceType: "wiki_template", resourceIdFromParams: (p) => p.id ?? null })
  update(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const parsed = updateWikiTemplateSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.templates.update(id, parsed.data);
  }

  @Delete(":id")
  @RequirePermissions(PERMISSIONS.WIKI_ADMIN)
  @Audited({ action: "wiki.template.delete", resourceType: "wiki_template", resourceIdFromParams: (p) => p.id ?? null })
  remove(@Param("id", ParseUUIDPipe) id: string) {
    return this.templates.remove(id);
  }
}
