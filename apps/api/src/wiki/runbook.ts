import { BadRequestException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { Db } from "../db/db.module";
import { wikiPages } from "../db/schema";

/**
 * The runbook link of a monitor or infrastructure host: a wiki page id, or null to remove it. Only that the page exists is
 * checked here; who may read its title is the wiki's own rule, applied when the page is opened.
 */
export async function checkRunbookPage(db: Db, pageId: string | null | undefined): Promise<string | null | undefined> {
  if (pageId === undefined || pageId === null) return pageId;
  const [row] = await db.select({ id: wikiPages.id }).from(wikiPages).where(eq(wikiPages.id, pageId)).limit(1);
  if (!row) throw new BadRequestException("That wiki page does not exist (it may have been deleted).");
  return pageId;
}
