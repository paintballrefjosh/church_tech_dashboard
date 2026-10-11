import { Injectable } from "@nestjs/common";
import { sectionOff, type Section, type NextService } from "@church/shared";
import type { HomeContext, SectionBuilder } from "../home.types";

/** Stub: Phase 1 fills this in. */
@Injectable()
export class HomeServiceSection implements SectionBuilder<NextService> {
  async build(_ctx: HomeContext): Promise<Section<NextService>> {
    return sectionOff("unavailable", "not built yet");
  }
}
