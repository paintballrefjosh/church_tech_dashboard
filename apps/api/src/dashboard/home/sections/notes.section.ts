import { Injectable } from "@nestjs/common";
import { PERMISSIONS, sectionOff, sectionOk, type NotesDigest, type Section } from "@church/shared";
import { NotesService } from "../../../notes/notes.service";
import type { HomeContext, SectionBuilder } from "../home.types";

export const NOTES_RECENT_LIMIT = 5;

@Injectable()
export class HomeNotesSection implements SectionBuilder<NotesDigest> {
  constructor(private readonly notes: NotesService) {}

  async build(ctx: HomeContext): Promise<Section<NotesDigest>> {
    if (!ctx.user.permissions.includes(PERMISSIONS.NOTES_READ_OWN)) return sectionOff("forbidden");
    // The user's own, not archived.
    const rows = await this.notes.list(ctx.user.id, { archived: false });
    const recent = [...rows]
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, NOTES_RECENT_LIMIT)
      .map((n) => ({
        id: n.id,
        title: n.title.trim() || "Untitled note",
        href: "/notes",
        updatedAt: n.updatedAt.toISOString(),
      }));
    return sectionOk({ count: rows.length, recent });
  }
}
