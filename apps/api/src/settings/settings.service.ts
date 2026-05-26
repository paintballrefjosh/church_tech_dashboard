import { Injectable, Inject } from "@nestjs/common";
import { eq, asc } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { settings } from "../db/schema";

@Injectable()
export class SettingsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async list(): Promise<Array<{ key: string; value: unknown; updatedAt: Date; updatedBy: string | null }>> {
    return this.db.select().from(settings).orderBy(asc(settings.key));
  }

  async get(key: string): Promise<unknown> {
    const [row] = await this.db.select().from(settings).where(eq(settings.key, key)).limit(1);
    return row?.value;
  }

  async set(key: string, value: unknown, byUserId: string | null): Promise<void> {
    await this.db
      .insert(settings)
      .values({ key, value: value as never, updatedBy: byUserId, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: value as never, updatedBy: byUserId, updatedAt: new Date() },
      });
  }

  async delete(key: string): Promise<void> {
    await this.db.delete(settings).where(eq(settings.key, key));
  }
}
