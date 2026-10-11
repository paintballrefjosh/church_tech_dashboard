import { Injectable } from "@nestjs/common";
import { sectionOff, type Section, type NotesDigest } from "@church/shared";
import type { HomeContext, SectionBuilder } from "../home.types";

/** Stub: Phase 1 fills this in. */
@Injectable()
export class HomeNotesSection implements SectionBuilder<NotesDigest> {
  async build(_ctx: HomeContext): Promise<Section<NotesDigest>> {
    return sectionOff("unavailable", "not built yet");
  }
}
