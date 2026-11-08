import { and, eq, gt, lte } from "drizzle-orm";
import type { Db } from "../../../db/db.module";
import { signageDevices, signageOverrides, signageScreens } from "../../../db/schema/signage";

/**
 * What the home page says about signage (docs/signage.md): the Pis that are set up and switched on, and which of them
 * are offline. "Offline" is the `signage-watch` job's own judgment (`offline_alerted`: silent past the limit while its
 * screen should be on), so the home page and the offline alert never disagree, and a TV that is off by its
 * power times is not shown as a problem. Nothing about a Pi's address leaves here: the home page is for every Signage
 * reader, and addresses are the module's admin tier.
 */
export interface SignageHealth {
  total: number;
  offline: Array<{ id: string; name: string; screenId: string | null; lastSeenAt: Date | null }>;
  /** Events (notices) showing now. */
  eventsNow: number;
}

/** Null when no Pi is set up: an install that does not use signage gets no extra row on the home page. */
export async function readSignageHealth(db: Db, now: Date): Promise<SignageHealth | null> {
  const [devices, events] = await Promise.all([
    db
      .select({
        id: signageDevices.id,
        name: signageDevices.name,
        screenId: signageDevices.screenId,
        screenName: signageScreens.name,
        lastSeenAt: signageDevices.lastSeenAt,
        offlineAlerted: signageDevices.offlineAlerted,
      })
      .from(signageDevices)
      .leftJoin(signageScreens, eq(signageScreens.id, signageDevices.screenId))
      .where(and(eq(signageDevices.status, "active"), eq(signageDevices.enabled, true))),
    db
      .select({ id: signageOverrides.id })
      .from(signageOverrides)
      .where(and(lte(signageOverrides.startsAt, now), gt(signageOverrides.endsAt, now))),
  ]);
  if (devices.length === 0) return null;
  return {
    total: devices.length,
    offline: devices
      .filter((d) => d.offlineAlerted)
      .map((d) => ({ id: d.id, name: d.screenName ?? d.name, screenId: d.screenId, lastSeenAt: d.lastSeenAt })),
    eventsNow: events.length,
  };
}
