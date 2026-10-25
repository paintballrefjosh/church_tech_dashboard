import { BadRequestException, Inject, Injectable, Logger, NotFoundException, type OnModuleInit } from "@nestjs/common";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  renewalNoticeTitle,
  renewalReminderDue,
  siteToday,
  type CreateRenewalInput,
  type Renewal,
  type RenewalCategory,
  type UpdateRenewalInput,
} from "@church/shared";
import { DB, type Db } from "../db/db.module";
import { groupMemberships, groups, renewals, users } from "../db/schema";
import { ClusterJobs } from "../cluster/cluster-jobs.service";
import { NotificationsService } from "../notifications/notifications.service";
import { NotificationDeliveryService } from "../notifications/notification-delivery.service";

type Row = typeof renewals.$inferSelect;

const EVERY_MS = 60 * 60_000;

/**
 * Renewals: the list (monitoring tiers, like cabinets and IPAM) and the hourly `renewal-reminders` job. A reminder is
 * CLAIMED with a conditional UPDATE of `reminded_for` before it is sent, so two nodes never both send it; a crash after
 * the claim loses at most that one notice (the list still shows it as due).
 */
@Injectable()
export class RenewalsService implements OnModuleInit {
  private readonly logger = new Logger(RenewalsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jobs: ClusterJobs,
    private readonly notifications: NotificationsService,
    private readonly delivery: NotificationDeliveryService,
  ) {}

  onModuleInit(): void {
    this.jobs.register({ name: "renewal-reminders", everyMs: EVERY_MS, initialDelayMs: 3 * 60_000, run: async () => void (await this.remindOnce()) });
  }

  private async toDto(rows: Row[]): Promise<Renewal[]> {
    const ownerIds = [...new Set(rows.map((r) => r.ownerUserId).filter((x): x is string => !!x))];
    const names = new Map<string, string>();
    if (ownerIds.length) {
      for (const u of await this.db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, ownerIds))) {
        names.set(u.id, u.name ?? u.email);
      }
    }
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      category: r.category as RenewalCategory,
      vendor: r.vendor,
      renewsOn: r.renewsOn,
      cost: r.cost,
      autoRenew: r.autoRenew,
      ownerUserId: r.ownerUserId,
      ownerName: r.ownerUserId ? (names.get(r.ownerUserId) ?? null) : null,
      notes: r.notes,
      remindDays: [...r.remindDays].sort((a, b) => b - a),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  async list(): Promise<Renewal[]> {
    return this.toDto(await this.db.select().from(renewals).orderBy(asc(renewals.renewsOn), asc(renewals.name)));
  }

  private async row(id: string): Promise<Row> {
    const [r] = await this.db.select().from(renewals).where(eq(renewals.id, id)).limit(1);
    if (!r) throw new NotFoundException("Renewal not found");
    return r;
  }

  async get(id: string): Promise<Renewal> {
    return (await this.toDto([await this.row(id)]))[0]!;
  }

  private async checkOwner(id: string | null | undefined): Promise<void> {
    if (!id) return;
    const [u] = await this.db.select({ id: users.id }).from(users).where(and(eq(users.id, id), isNull(users.deletedAt))).limit(1);
    if (!u) throw new BadRequestException("That person does not exist.");
  }

  async create(input: CreateRenewalInput): Promise<Renewal> {
    await this.checkOwner(input.ownerUserId);
    const [r] = await this.db
      .insert(renewals)
      .values({ ...input, remindDays: [...new Set(input.remindDays)] })
      .returning();
    return (await this.toDto([r!]))[0]!;
  }

  async update(id: string, input: UpdateRenewalInput): Promise<Renewal> {
    await this.row(id);
    await this.checkOwner(input.ownerUserId);
    const patch: Partial<typeof renewals.$inferInsert> = { ...input, updatedAt: new Date() };
    if (input.remindDays) patch.remindDays = [...new Set(input.remindDays)];
    const [r] = await this.db.update(renewals).set(patch).where(eq(renewals.id, id)).returning();
    return (await this.toDto([r!]))[0]!;
  }

  async remove(id: string): Promise<void> {
    await this.row(id);
    await this.db.delete(renewals).where(eq(renewals.id, id));
  }

  /** Who hears about a renewal: its owner, else everyone in the admin group (active accounts only, via NotificationsService). */
  private async recipients(r: Row): Promise<string[]> {
    if (r.ownerUserId) return [r.ownerUserId];
    const rows = await this.db
      .select({ id: groupMemberships.userId })
      .from(groupMemberships)
      .innerJoin(groups, eq(groups.id, groupMemberships.groupId))
      .where(eq(groups.name, "admin"));
    return rows.map((x) => x.id);
  }

  async remindOnce(now: Date = new Date()): Promise<{ sent: number }> {
    const today = siteToday(now, await this.delivery.zone());
    let sent = 0;
    for (const r of await this.db.select().from(renewals)) {
      const marker = renewalReminderDue(r, r.remindedFor, today);
      if (!marker) continue;
      // Claim it: only the node whose UPDATE changes the marker sends.
      const claimed = await this.db
        .update(renewals)
        .set({ remindedFor: marker })
        .where(and(eq(renewals.id, r.id), or(isNull(renewals.remindedFor), sql`${renewals.remindedFor} <> ${marker}`)))
        .returning({ id: renewals.id });
      if (claimed.length === 0) continue;
      const parts = [r.vendor && `From ${r.vendor}.`, r.autoRenew ? "It renews automatically: check the payment card and that you still want it." : "It does not renew by itself."];
      await this.notifications.createMany(
        (await this.recipients(r)).map((id) => ({
          recipientUserId: id,
          kind: "renewal.due",
          title: renewalNoticeTitle(r.name, r.renewsOn, today),
          body: parts.filter(Boolean).join(" "),
          link: "/renewals",
        })),
      );
      sent++;
    }
    if (sent > 0) this.logger.log(`renewal reminders sent: ${sent}`);
    return { sent };
  }
}
