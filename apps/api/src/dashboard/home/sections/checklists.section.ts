import { Injectable } from "@nestjs/common";
import { sectionOff, type Section, type ChecklistDigest } from "@church/shared";
import type { HomeContext, SectionBuilder } from "../home.types";

/** Stub: Phase 1 fills this in. */
@Injectable()
export class HomeChecklistsSection implements SectionBuilder<ChecklistDigest> {
  async build(_ctx: HomeContext): Promise<Section<ChecklistDigest>> {
    return sectionOff("unavailable", "not built yet");
  }
}
