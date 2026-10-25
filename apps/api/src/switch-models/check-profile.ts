import { BadRequestException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { Db } from "../db/db.module";
import { switchModels } from "../db/schema";

/**
 * The device profile chosen to draw a device's picture (a Cisco switch, an infra host, a UniFi device): it must exist and
 * be a whole device, not an add-on module (a module is only ever drawn on a host's picture). null/undefined pass through.
 */
export async function checkDeviceProfile(db: Db, id: string | null | undefined): Promise<string | null | undefined> {
  if (id === undefined || id === null) return id;
  const [m] = await db.select({ id: switchModels.id, kind: switchModels.kind }).from(switchModels).where(eq(switchModels.id, id)).limit(1);
  if (!m) throw new BadRequestException("That device profile does not exist (it may have been deleted).");
  if (m.kind === "module") throw new BadRequestException("That device profile is an add-on module; pick a whole device.");
  return id;
}
