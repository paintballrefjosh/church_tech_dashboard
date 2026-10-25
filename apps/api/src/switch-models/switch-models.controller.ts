import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  ParseUUIDPipe,
  Body,
  Req,
  Res,
  BadRequestException,
  PayloadTooLargeException,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  PERMISSIONS,
  SWITCH_MODEL_SIDES,
  createSwitchModelSchema,
  updateSwitchModelSchema,
  type SwitchModelSide,
} from "@church/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { Audited } from "../audit/audit.decorator";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { SwitchModelsService, MAX_SWITCH_IMAGE_BYTES } from "./switch-models.service";
import { contentDisposition } from "../attachments/content-disposition";

/**
 * Switch models for the switch view. Anyone who can see monitoring reads them (the pictures are drawn on the switch
 * pages); changing them is the monitoring admin tier, like the switches themselves.
 */
const READ = PERMISSIONS.MONITORS_READ_ANY;
const WRITE = PERMISSIONS.MONITORS_WRITE_ANY;

function sideOf(raw: string): SwitchModelSide {
  if ((SWITCH_MODEL_SIDES as readonly string[]).includes(raw)) return raw as SwitchModelSide;
  throw new BadRequestException("side must be front or back");
}

@Controller("switch-models")
export class SwitchModelsController {
  constructor(private readonly models: SwitchModelsService) {}

  @Get()
  @RequirePermissions(READ)
  list() {
    return this.models.list();
  }

  @Post()
  @RequirePermissions(WRITE)
  @Audited({ action: "switch_model.create", resourceType: "switch_model" })
  create(@Body() body: unknown) {
    const parsed = createSwitchModelSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.models.create(parsed.data);
  }

  @Patch(":id")
  @RequirePermissions(WRITE)
  @Audited({ action: "switch_model.update", resourceType: "switch_model", resourceIdFromParams: (p) => p.id ?? null })
  update(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const parsed = updateSwitchModelSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.models.update(id, parsed.data);
  }

  @Delete(":id")
  @RequirePermissions(WRITE)
  @Audited({ action: "switch_model.delete", resourceType: "switch_model", resourceIdFromParams: (p) => p.id ?? null })
  async remove(@Param("id", ParseUUIDPipe) id: string) {
    await this.models.remove(id);
    return { ok: true };
  }

  @Get(":id/images/:side")
  @RequirePermissions(READ)
  async image(@Param("id", ParseUUIDPipe) id: string, @Param("side") side: string, @Res() reply: FastifyReply) {
    const img = await this.models.openImage(id, sideOf(side));
    // The page asks for `?v=<attachment id>`, so a replaced picture is a different URL and this can be kept a long time.
    void reply
      .header("content-type", img.contentType)
      .header("x-content-type-options", "nosniff")
      .header("content-disposition", contentDisposition("inline", img.filename))
      .header("cache-control", "private, max-age=86400")
      .send(img.stream);
  }

  @Post(":id/images/:side")
  @RequirePermissions(WRITE)
  @Audited({ action: "switch_model.image.upload", resourceType: "switch_model", resourceIdFromParams: (p) => p.id ?? null })
  async uploadImage(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("side") side: string,
    @Req() req: FastifyRequest,
  ) {
    const which = sideOf(side);
    const part = await (req as FastifyRequest & {
      file: () => Promise<{ filename: string; mimetype: string; file: NodeJS.ReadableStream & { truncated?: boolean } } | undefined>;
    }).file();
    if (!part) throw new BadRequestException("multipart 'file' field is required");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of part.file) {
      const b = chunk as Buffer;
      size += b.length;
      // Keep reading to the end (the request must be drained) but stop holding on to it once it is too big.
      if (size <= MAX_SWITCH_IMAGE_BYTES) chunks.push(b);
    }
    if (part.file.truncated === true || size > MAX_SWITCH_IMAGE_BYTES) {
      throw new PayloadTooLargeException(`The picture is larger than ${MAX_SWITCH_IMAGE_BYTES / (1024 * 1024)} MiB. Save it smaller (about 2000 px wide is plenty).`);
    }
    return this.models.setImage(id, which, user.id, { filename: part.filename, mimetype: part.mimetype, bytes: Buffer.concat(chunks) });
  }

  @Delete(":id/images/:side")
  @RequirePermissions(WRITE)
  @Audited({ action: "switch_model.image.delete", resourceType: "switch_model", resourceIdFromParams: (p) => p.id ?? null })
  removeImage(@Param("id", ParseUUIDPipe) id: string, @Param("side") side: string) {
    return this.models.removeImage(id, sideOf(side));
  }
}
