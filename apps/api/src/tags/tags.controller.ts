import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  BadRequestException,
} from "@nestjs/common";
import {
  PERMISSIONS,
  TAGGABLE_RESOURCE_TYPES,
  createTagSchema,
  updateTagSchema,
  setResourceTagsSchema,
  type TaggableResourceType,
} from "@church/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { Audited } from "../audit/audit.decorator";
import { TagsService } from "./tags.service";
import { TicketsService } from "../tickets/tickets.service";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";

@Controller("tags")
export class TagsController {
  constructor(
    private readonly tags: TagsService,
    private readonly tickets: TicketsService,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.TAGS_READ_ANY)
  list() {
    return this.tags.list();
  }

  @Post()
  @RequirePermissions(PERMISSIONS.TAGS_WRITE_ANY)
  @Audited({ action: "tag.create", resourceType: "tag" })
  async create(@Body() body: unknown) {
    const parsed = createTagSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.tags.create(parsed.data);
  }

  @Patch(":id")
  @RequirePermissions(PERMISSIONS.TAGS_WRITE_ANY)
  @Audited({
    action: "tag.update",
    resourceType: "tag",
    resourceIdFromParams: (p) => p.id ?? null,
  })
  async update(@Param("id") id: string, @Body() body: unknown) {
    const parsed = updateTagSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.tags.update(id, parsed.data);
  }

  @Delete(":id")
  @RequirePermissions(PERMISSIONS.TAGS_WRITE_ANY)
  @Audited({
    action: "tag.delete",
    resourceType: "tag",
    resourceIdFromParams: (p) => p.id ?? null,
  })
  remove(@Param("id") id: string) {
    return this.tags.delete(id);
  }

  // The two below operate on a *resource*'s tag set, not the tag catalogue.
  // Auth is shared with the underlying resource: anyone who can edit the
  // ticket/note/wiki page can tag it. We're permissive here because each
  // resource's own controller has already gated the parent action.

  @Get(":resourceType/:resourceId")
  @RequirePermissions(PERMISSIONS.TAGS_READ_ANY)
  forResource(
    @Param("resourceType") resourceType: string,
    @Param("resourceId") resourceId: string,
  ) {
    if (!(TAGGABLE_RESOURCE_TYPES as readonly string[]).includes(resourceType)) {
      throw new BadRequestException(`unknown resource type ${resourceType}`);
    }
    return this.tags.forResource(resourceType as TaggableResourceType, resourceId);
  }

  @Post(":resourceType/:resourceId")
  @RequirePermissions(PERMISSIONS.TAGS_READ_ANY)
  @Audited({
    action: "tag.assign",
    resourceType: "tag",
    resourceIdFromParams: (p) => p.resourceId ?? null,
  })
  async setForResource(
    @CurrentUser() user: AuthenticatedUser,
    @Param("resourceType") resourceType: string,
    @Param("resourceId") resourceId: string,
    @Body() body: unknown,
  ) {
    if (!(TAGGABLE_RESOURCE_TYPES as readonly string[]).includes(resourceType)) {
      throw new BadRequestException(`unknown resource type ${resourceType}`);
    }
    const parsed = setResourceTagsSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const type = resourceType as TaggableResourceType;
    const before = resourceType === "ticket" ? await this.tags.forResource(type, resourceId) : [];
    const after = await this.tags.setResourceTags(type, resourceId, parsed.data.tagIds);
    if (resourceType === "ticket") {
      await this.tickets.logSetChange(
        resourceId,
        user,
        "changed tags",
        before.map((t) => t.name),
        after.map((t) => t.name),
      );
    }
    return after;
  }
}
