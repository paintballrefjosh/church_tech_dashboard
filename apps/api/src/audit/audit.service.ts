import { Injectable, Inject } from "@nestjs/common";
import { desc, eq, and, lt, type SQL } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { auditLog } from "../db/schema";

export interface AuditWrite {
  actorUserId?: string | null;
  actorEmail?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}

@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async write(entry: AuditWrite): Promise<void> {
    await this.db.insert(auditLog).values({
      actorUserId: entry.actorUserId ?? null,
      actorEmail: entry.actorEmail ?? null,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId ?? null,
      before: (entry.before ?? null) as never,
      after: (entry.after ?? null) as never,
      ip: entry.ip ?? null,
      userAgent: entry.userAgent ?? null,
    });
  }

  async list(opts: {
    limit?: number;
    cursor?: Date;
    actorUserId?: string;
    resourceType?: string;
    action?: string;
  }) {
    const conditions: SQL[] = [];
    if (opts.cursor) conditions.push(lt(auditLog.ts, opts.cursor));
    if (opts.actorUserId) conditions.push(eq(auditLog.actorUserId, opts.actorUserId));
    if (opts.resourceType) conditions.push(eq(auditLog.resourceType, opts.resourceType));
    if (opts.action) conditions.push(eq(auditLog.action, opts.action));

    const where = conditions.length === 0 ? undefined : conditions.length === 1 ? conditions[0] : and(...conditions);

    const rows = await this.db
      .select()
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.ts))
      .limit(opts.limit ?? 50);
    return rows;
  }
}
