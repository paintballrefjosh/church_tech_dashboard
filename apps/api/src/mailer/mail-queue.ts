import { Inject, Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from "@nestjs/common";
import { ClusterJobs } from "../cluster/cluster-jobs.service";
import { MAIL_OUTBOX_STORE, type ClaimedMail, type MailOutboxStore } from "./mail-outbox.store";
import { MailerService, type MailMessage } from "./mailer.service";

/** Attempts per message, counting the first. */
export const MAIL_ATTEMPTS = 5;
/** Backoff before attempt n+1 is `MAIL_BACKOFF_SEC * 2^(n-1)`: 5s, 10s, 20s, 40s. */
export const MAIL_BACKOFF_SEC = 5;
/** How long a node holds a message it is sending before another may take it. */
const CLAIM_SEC = 120;
/** How often a node looks for mail that is due (retries, or a node that died mid-send). */
const POLL_MS = 2_000;
const BATCH = 5;

/**
 * Retry queue for outbound email, kept in the database (`mail_outbox`; this
 * replaced a BullMQ queue in Redis). Every node runs the same worker and claims
 * what is due, so mail keeps going out if a node stops, and a message is sent
 * by one node. Delivery is at least once: a node that dies after the SMTP server
 * accepted a message but before recording it will see it sent again.
 *
 * Retry policy as before: 5 attempts with exponential backoff from 5 seconds.
 * A message that fails every attempt stays in the table as `failed` for a day.
 */
@Injectable()
export class MailQueue implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MailQueue.name);
  private timer: NodeJS.Timeout | null = null;
  private draining: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly mailer: MailerService,
    @Inject(MAIL_OUTBOX_STORE) private readonly store: MailOutboxStore,
    private readonly jobs: ClusterJobs,
  ) {
    // Setter injection in the reverse direction so MailerService.sendBestEffort
    // routes through us.
    this.mailer.setQueue(this);
  }

  onModuleInit(): void {
    this.timer = setInterval(() => this.kick(), POLL_MS);
    this.timer.unref();
    this.jobs.register({
      name: "mail-outbox-prune",
      everyMs: 60 * 60_000,
      initialDelayMs: 5 * 60_000,
      run: () => this.store.prune(24),
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Let a send that is under way finish; give up waiting after a few seconds.
    if (this.draining) await Promise.race([this.draining, new Promise((r) => setTimeout(r, 5000))]);
  }

  /**
   * Queue a message and start sending it now. If the database will not take it,
   * send inline so the caller still gets best-effort delivery.
   */
  async enqueue(msg: MailMessage): Promise<void> {
    try {
      await this.store.add(msg);
    } catch (err) {
      this.logger.warn(`could not queue mail (${(err as Error).message}); sending inline`);
      await this.mailer.sendNow(msg).catch((e: unknown) => {
        this.logger.warn(`inline send failed: ${(e as Error).message}`);
      });
      return;
    }
    this.kick();
  }

  /** Start a drain unless one is already running. */
  kick(): void {
    if (this.stopped || this.draining) return;
    this.draining = this.drain().finally(() => {
      this.draining = null;
    });
  }

  private async drain(): Promise<void> {
    for (;;) {
      let batch: ClaimedMail[];
      try {
        batch = await this.store.claim(BATCH, CLAIM_SEC);
      } catch (err) {
        // Including a collision with another node's claim: just try again next poll.
        this.logger.debug(`mail claim failed: ${(err as Error).message}`);
        return;
      }
      if (batch.length === 0) return;
      await Promise.all(batch.map((m) => this.deliver(m)));
      if (this.stopped) return;
    }
  }

  private async deliver(m: ClaimedMail): Promise<void> {
    try {
      await this.mailer.sendNow(m.message);
      await this.store.sent(m.id);
    } catch (err) {
      const msg = (err as Error).message;
      this.logger.warn(`mail ${m.id} failed (attempt ${m.attempts}/${MAIL_ATTEMPTS}): ${msg}`);
      try {
        if (m.attempts >= MAIL_ATTEMPTS) await this.store.giveUp(m.id, msg);
        else await this.store.retryLater(m.id, MAIL_BACKOFF_SEC * 2 ** (m.attempts - 1), msg);
      } catch (e) {
        // The claim lapses on its own and the message comes round again.
        this.logger.warn(`could not record the failure of mail ${m.id}: ${(e as Error).message}`);
      }
    }
  }
}
