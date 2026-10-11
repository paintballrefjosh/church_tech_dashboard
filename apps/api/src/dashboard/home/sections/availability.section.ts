import { Injectable } from "@nestjs/common";
import {
  AVAILABILITY_AREAS,
  PERMISSIONS,
  bucketAvailability,
  sectionOff,
  sectionOk,
  utcHourStartMs,
  type AvailabilityGrid,
  type Section,
} from "@church/shared";
import { AvailabilityStore } from "../../../availability/availability.store";
import type { HomeContext, SectionBuilder } from "../home.types";

export const AVAILABILITY_HOURS = 12;

/** The last 12 hours of up/down for every system the person may see (the Glass window). */
@Injectable()
export class HomeAvailabilitySection implements SectionBuilder<AvailabilityGrid> {
  constructor(private readonly store: AvailabilityStore) {}

  async build(ctx: HomeContext): Promise<Section<AvailabilityGrid>> {
    const perms = ctx.user.permissions;
    if (!perms.includes(PERMISSIONS.MONITORS_READ_ANY)) return sectionOff("forbidden");
    const canUnifi = perms.includes(PERMISSIONS.UNIFI_READ_ANY);
    const kinds = AVAILABILITY_AREAS.map((a) => a.kind).filter((k) => k !== "unifi_device" || canUnifi);
    const since = new Date(utcHourStartMs(ctx.now) - (AVAILABILITY_HOURS - 1) * 3_600_000);
    try {
      const rows = await this.store.hourly(since, kinds);
      return sectionOk(bucketAvailability(rows, { now: ctx.now, hours: AVAILABILITY_HOURS, kinds }));
    } catch {
      return sectionOff("unavailable", "could not read the history");
    }
  }
}
