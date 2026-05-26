import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  Req,
  Res,
  BadRequestException,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
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
import { AttachmentsService } from "../attachments/attachments.service";

@Controller("wiki")
export class WikiController {
  constructor(
    private readonly wiki: WikiService,
    private readonly realtime: RealtimeGateway,
    private readonly attachments: AttachmentsService,
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

  // ---- attachments (Phase 1.5.1) ----

  @Get(":id/attachments")
  @RequirePermissions(PERMISSIONS.WIKI_READ_OWN)
  async listAttachments(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.wiki.assertReadable(user, id);
    return this.attachments.listByParent("wiki_page", id);
  }

  @Post(":id/attachments")
  @RequirePermissions(PERMISSIONS.WIKI_READ_OWN)
  @Audited({
    action: "wiki.attachment.upload",
    resourceType: "wiki_page",
    resourceIdFromParams: (p) => p.id ?? null,
  })
  async uploadAttachment(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Req() req: FastifyRequest,
  ) {
    await this.wiki.assertWritable(user, id);
    const part = await (req as FastifyRequest & {
      file: () => Promise<
        { filename: string; mimetype: string; file: NodeJS.ReadableStream } | undefined
      >;
    }).file();
    if (!part) throw new BadRequestException("multipart 'file' field is required");
    try {
      return await this.attachments.upload("wiki_page", id, user.id, {
        filename: part.filename,
        mimetype: part.mimetype,
        stream: part.file as never,
        sizeLimit: 0,
      });
    } finally {
      part.file.resume?.();
    }
  }

  @Get(":id/attachments/:aid")
  @RequirePermissions(PERMISSIONS.WIKI_READ_OWN)
  async downloadAttachment(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Param("aid") aid: string,
    @Res() reply: FastifyReply,
  ) {
    await this.wiki.assertReadable(user, id);
    const { row, storageKey } = await this.attachments.getOne("wiki_page", id, aid);
    const stream = await this.attachments.openStream(storageKey);
    const disp = row.contentType.startsWith("image/") ? "inline" : "attachment";
    void reply
      .header("content-type", row.contentType)
      .header(
        "content-disposition",
        `${disp}; filename="${encodeURIComponent(row.filename)}"`,
      )
      .header("cache-control", "private, max-age=3600")
      .send(stream);
  }

  @Delete(":id/attachments/:aid")
  @RequirePermissions(PERMISSIONS.WIKI_READ_OWN)
  @Audited({
    action: "wiki.attachment.delete",
    resourceType: "wiki_page",
    resourceIdFromParams: (p) => p.id ?? null,
  })
  async deleteAttachment(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Param("aid") aid: string,
  ) {
    await this.wiki.assertWritable(user, id);
    await this.attachments.delete("wiki_page", id, aid);
    return { ok: true };
  }
}
