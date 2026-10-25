import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { and, asc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { alertOutbox } from "../db/schema";
import { ClusterJobs } from "../cluster/cluster-jobs.service";
import { NotificationsService } from "../notifications/notifications.service";
import { InfraService } from "../infra/infra.service";
import { SettingsService } from "../settings/settings.service";
import { deleteInBatches } from "../retention/batched-delete";
import { AlertChannelsService } from "./alert-channels.service";

const EVERY_MS = 5_000;
const BATCH = 20;
const MAX_ATTEMPTS = 5;
/**
 * An alert older than this when it is picked up (the API was down, or a rolling upgrade ran the new probe worker before
 * the new API) goes to the bell only: an email, a push or a team-chat message about something half an hour old is noise.
 */
export const ALERT_STALE_MS = 30 * 60_000;
const KEEP_SENT_DAYS = 7;
const PRUNE_EVERY_MS = 10 * 60_000;

type OutboxRow = typeof alertOutbox.$inferSelect;

/**
 * Sends the queued alerts (`alert_outbox`): to the alert channels, and for rows from the probe worker (`fanout`) also to
 * the monitoring recipients through NotificationsService, so bell, email and push follow each person's own choices. One
 * cluster job; rows are CLAIMED with one conditional UPDATE (judged by the database clock) before sending, so after a
 * handover two nodes never send the same alert. At-least-once: a node that dies mid-send leaves its claim to lapse and the
 * row is sent again (at most MAX_ATTEMPTS times).
 */
@Injectable()
export class AlertDispatch implements OnModuleInit {
  private readonly logger = new Logger(AlertDispatch.name);
  private lastPrune = 0;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jobs: ClusterJobs,
    private readonly notifications: NotificationsService,
    private readonly infra: InfraService,
    private readonly settings: SettingsService,
    private readonly channels: AlertChannelsService,
  ) {}

  onModuleInit(): void {
    this.jobs.register({
      name: "alert-dispatch",
      everyMs: EVERY_MS,
      schedule: "fixed-delay",
      initialDelayMs: 5_000,
      run: async () => void (await this.runOnce()),
    });
  }

  /** Claim up to BATCH unsent rows nobody holds. The subquery picks, the UPDATE re-checks and takes them. */
  async claim(): Promise<OutboxRow[]> {
    const free = and(isNull(alertOutbox.sentAt), lt(alertOutbox.attempts, MAX_ATTEMPTS), or(isNull(alertOutbox.claimedUntil), lt(alertOutbox.claimedUntil, sql`now()`)));
    const pick = this.db.select({ id: alertOutbox.id }).from(alertOutbox).where(free).orderBy(asc(alertOutbox.createdAt)).limit(BATCH);
    return this.db
      .update(alertOutbox)
      .set({ claimedUntil: sql`now() + interval '60 seconds'`, attempts: sql`${alertOutbox.attempts} + 1` })
      .where(and(inArray(alertOutbox.id, pick), free))
      .returning();
  }

  async runOnce(now: Date = new Date()): Promise<{ sent: number; stale: number }> {
    const out = { sent: 0, stale: 0 };
    const rows = await this.claim();
    if (rows.length > 0) {
      const base = await this.settings.publicBaseUrl();
      let recipients: string[] | null = null;
      for (const row of rows) {
        const stale = now.getTime() - row.createdAt.getTime() > ALERT_STALE_MS;
        try {
          if (row.fanout) {
            recipients ??= await this.infra.monitoringRecipientIds();
            await this.notifications.createMany(
              recipients.map((id) => ({
                recipientUserId: id,
                kind: row.kind,
                title: row.title,
                body: row.body,
                link: row.link,
                // This job sends to the channels itself, just below.
                alertChannels: false,
                ...(stale ? { email: false, push: false } : {}),
              })),
            );
          }
          if (!stale) {
            const url = row.link ? (/^https?:\/\//i.test(row.link) ? row.link : base ? `${base}${row.link}` : null) : null;
            await this.channels.sendToChannels({ kind: row.kind, title: row.title, body: row.body, url, at: row.createdAt });
          } else {
            out.stale++;
          }
          await this.db.update(alertOutbox).set({ sentAt: sql`now()`, claimedUntil: null, lastError: null }).where(eq(alertOutbox.id, row.id));
          out.sent++;
        } catch (err) {
          const message = (err as Error).message.slice(0, 500);
          this.logger.warn(`alert ${row.id} (${row.kind}) not sent: ${message}`);
          await this.db.update(alertOutbox).set({ claimedUntil: null, lastError: message }).where(eq(alertOutbox.id, row.id)).catch(() => undefined);
        }
      }
    }
    if (now.getTime() - this.lastPrune > PRUNE_EVERY_MS) {
      this.lastPrune = now.getTime();
      await this.prune().catch((err: Error) => this.logger.warn(`alert outbox prune failed: ${err.message}`));
    }
    return out;
  }

  /** Remove alerts sent more than a week ago (and ones that gave up), in batches. */
  private async prune(): Promise<void> {
    const cutoff = new Date(Date.now() - KEEP_SENT_DAYS * 86_400_000);
    const done = or(and(isNotNull(alertOutbox.sentAt), lt(alertOutbox.sentAt, cutoff)), and(isNull(alertOutbox.sentAt), lt(alertOutbox.createdAt, cutoff)));
    await deleteInBatches(async (limit) => {
      const gone = await this.db
        .delete(alertOutbox)
        .where(inArray(alertOutbox.id, this.db.select({ id: alertOutbox.id }).from(alertOutbox).where(done).limit(limit)))
        .returning({ id: alertOutbox.id });
      return gone.length;
    });
  }
}
