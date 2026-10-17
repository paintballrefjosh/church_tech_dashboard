import { Inject, Injectable } from "@nestjs/common";
import { eq, inArray } from "drizzle-orm";
import { DEFAULT_NOTIFICATION_DELIVERY, type NotificationDelivery } from "@church/shared";
import { DB, type Db } from "../db/db.module";
import { notificationDelivery } from "../db/schema";
import { SettingsService } from "../settings/settings.service";

/** A valid IANA zone name, else UTC (an unknown name makes Intl throw). */
export function validZone(name: unknown): string {
  if (typeof name !== "string" || name.trim() === "") return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return name;
  } catch {
    return "UTC";
  }
}

type Row = typeof notificationDelivery.$inferSelect;

function toDelivery(row: Row | undefined): NotificationDelivery {
  if (!row) return { ...DEFAULT_NOTIFICATION_DELIVERY };
  return {
    quietEnabled: row.quietEnabled,
    quietStart: row.quietStart,
    quietEnd: row.quietEnd,
    digestEnabled: row.digestEnabled,
    digestAt: row.digestAt,
    urgentThrough: row.urgentThrough,
  };
}

/** Each person's quiet hours and summary choices (`notification_delivery`), and the clock they are read on. */
@Injectable()
export class NotificationDeliveryService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly settings: SettingsService,
  ) {}

  /** The site's time zone: quiet hours and the summary time are read on the church's clock, whatever the person's device says. */
  async zone(): Promise<string> {
    return validZone(await this.settings.get("site.timezone").catch(() => "UTC"));
  }

  async get(userId: string): Promise<NotificationDelivery> {
    const [row] = await this.db.select().from(notificationDelivery).where(eq(notificationDelivery.userId, userId)).limit(1);
    return toDelivery(row);
  }

  async getMany(userIds: string[]): Promise<Map<string, NotificationDelivery>> {
    const out = new Map<string, NotificationDelivery>();
    if (userIds.length === 0) return out;
    const rows = await this.db.select().from(notificationDelivery).where(inArray(notificationDelivery.userId, userIds));
    for (const r of rows) out.set(r.userId, toDelivery(r));
    return out;
  }

  async set(userId: string, value: NotificationDelivery): Promise<NotificationDelivery> {
    await this.db
      .insert(notificationDelivery)
      .values({ userId, ...value })
      .onConflictDoUpdate({ target: notificationDelivery.userId, set: { ...value, updatedAt: new Date() } });
    return value;
  }
}
