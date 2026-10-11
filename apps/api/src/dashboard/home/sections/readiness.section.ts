import { Injectable } from "@nestjs/common";
import { sectionOff, type Section, type Readiness } from "@church/shared";
import type { HomeContext, DerivedSectionBuilder, PrimarySections } from "../home.types";

/** Stub: Phase 4 fills this in. */
@Injectable()
export class HomeReadinessSection implements DerivedSectionBuilder<Readiness> {
  async build(_ctx: HomeContext, _primary: PrimarySections): Promise<Section<Readiness>> {
    return sectionOff("unavailable", "not built yet");
  }
}
