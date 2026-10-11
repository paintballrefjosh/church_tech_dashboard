import { Injectable } from "@nestjs/common";
import { sectionOff, type Section, type WeekDigest } from "@church/shared";
import type { HomeContext, SectionBuilder } from "../home.types";

/** Stub: Phase 4 fills this in. */
@Injectable()
export class HomeWeekSection implements SectionBuilder<WeekDigest> {
  async build(_ctx: HomeContext): Promise<Section<WeekDigest>> {
    return sectionOff("unavailable", "not built yet");
  }
}
