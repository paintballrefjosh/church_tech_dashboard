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
  createNoteSchema,
  updateNoteSchema,
  noteListQuerySchema,
} from "@church/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { Audited } from "../audit/audit.decorator";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { NotesService } from "./notes.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";

@Controller("notes")
export class NotesController {
  constructor(
    private readonly notes: NotesService,
    private readonly realtime: RealtimeGateway,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.NOTES_READ_OWN)
  async list(@CurrentUser() user: AuthenticatedUser, @Query() query: unknown) {
    const parsed = noteListQuerySchema.safeParse(query ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.notes.list(user.id, parsed.data);
  }

  @Get(":id")
  @RequirePermissions(PERMISSIONS.NOTES_READ_OWN)
  byId(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.notes.getById(user.id, id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.NOTES_WRITE_OWN)
  @Audited({ action: "note.create", resourceType: "note" })
  async create(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const parsed = createNoteSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const note = await this.notes.create(user.id, parsed.data);
    this.realtime.toUser(user.id, "note:created", note);
    return note;
  }

  @Patch(":id")
  @RequirePermissions(PERMISSIONS.NOTES_WRITE_OWN)
  @Audited({ action: "note.update", resourceType: "note", resourceIdFromParams: (p) => p.id ?? null })
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const parsed = updateNoteSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const note = await this.notes.update(user.id, id, parsed.data);
    this.realtime.toUser(user.id, "note:updated", note);
    return note;
  }

  @Delete(":id")
  @RequirePermissions(PERMISSIONS.NOTES_DELETE_OWN)
  @Audited({ action: "note.delete", resourceType: "note", resourceIdFromParams: (p) => p.id ?? null })
  async remove(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    const note = await this.notes.delete(user.id, id);
    this.realtime.toUser(user.id, "note:deleted", { id });
    return note;
  }
}
