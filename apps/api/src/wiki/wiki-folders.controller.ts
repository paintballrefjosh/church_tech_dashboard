import { Controller, Post, Patch, Delete, Param, Body, BadRequestException } from "@nestjs/common";
import { PERMISSIONS, createWikiFolderSchema, updateWikiFolderSchema } from "@church/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { Audited } from "../audit/audit.decorator";
import { WikiFoldersService } from "./wiki-folders.service";

/**
 * Reads go through GET /wiki/tree (WikiController) alongside pages, so the
 * web builds one merged tree from a single call. This controller only carries
 * the mutating folder routes.
 */
@Controller("wiki/folders")
export class WikiFoldersController {
  constructor(private readonly folders: WikiFoldersService) {}

  @Post()
  @RequirePermissions(PERMISSIONS.WIKI_CREATE)
  @Audited({ action: "wiki_folder.create", resourceType: "wiki_folder" })
  async create(@Body() body: unknown) {
    const parsed = createWikiFolderSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.folders.create(parsed.data);
  }

  @Patch(":id")
  @RequirePermissions(PERMISSIONS.WIKI_CREATE)
  @Audited({
    action: "wiki_folder.update",
    resourceType: "wiki_folder",
    resourceIdFromParams: (p) => p.id ?? null,
  })
  async update(@Param("id") id: string, @Body() body: unknown) {
    const parsed = updateWikiFolderSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.folders.update(id, parsed.data);
  }

  @Delete(":id")
  @RequirePermissions(PERMISSIONS.WIKI_CREATE)
  @Audited({
    action: "wiki_folder.delete",
    resourceType: "wiki_folder",
    resourceIdFromParams: (p) => p.id ?? null,
  })
  async remove(@Param("id") id: string) {
    return this.folders.delete(id);
  }
}
