import { Injectable } from "@nestjs/common";
import { sectionOff, type Section, type SystemsHealth } from "@church/shared";
import type { HomeContext, SectionBuilder } from "../home.types";

/** Stub: Phase 1 fills this in. */
@Injectable()
export class HomeSystemsSection implements SectionBuilder<SystemsHealth> {
  async build(_ctx: HomeContext): Promise<Section<SystemsHealth>> {
    return sectionOff("unavailable", "not built yet");
  }
}
