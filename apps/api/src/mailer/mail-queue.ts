import { Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from "@nestjs/common";
import { Queue, Worker, type Job } from "bullmq";
import Redis, { type Redis as RedisClient } from "ioredis";
import { MailerService, type MailMessage } from "./mailer.service";

const QUEUE_NAME = "mail";
const ATTEMPTS = 5;

/**
 * BullMQ-backed retry queue for outbound email. Replaces the previous
 * fire-and-forget `mailer.sendBestEffort()` for production usage; if Redis
 * isn't available we degrade gracefully and call the underlying mailer
 * synchronously (single-replica dev still works fine).
 *
 * Retry policy: 5 attempts with exponential backoff starting at 5 s. A
 * dropped SMTP connection or a transient outage at the relay rolls into
 * the retry naturally; a permanent failure (bad From: address, blocked
 * recipient) eventually surfaces in the BullMQ dead-letter pattern.
 */
@Injectable()
export class MailQueue implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MailQueue.name);
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private redis: RedisClient | null = null;

  constructor(private readonly mailer: MailerService) {
    // Setter injection in the reverse direction so MailerService.sendBestEffort
    // routes through us when we're up.
    this.mailer.setQueue(this);
  }

  async onModuleInit(): Promise<void> {
    const url = process.env.REDIS_URL;
    if (!url) {
      this.logger.warn("REDIS_URL not set; mail queue disabled, sends are immediate.");
      return;
    }
    try {
      // BullMQ requires maxRetriesPerRequest=null and enableReadyCheck=false
      // for blocking commands. We deliberately don't share this client with
      // anything else for that reason.
      this.redis = new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: false });
      this.queue = new Queue(QUEUE_NAME, { connection: this.redis });
      this.worker = new Worker(
        QUEUE_NAME,
        async (job: Job<MailMessage>) => {
          await this.mailer.sendNow(job.data);
        },
        {
          connection: this.redis,
          // Match attempts/backoff with what enqueue() requests below.
          autorun: true,
        },
      );
      this.worker.on("failed", (job, err) => {
        this.logger.warn(`mail job ${job?.id ?? "?"} failed (attempt ${job?.attemptsMade ?? "?"}): ${err.message}`);
      });
      this.logger.log("Mail queue connected (BullMQ + Redis)");
    } catch (err) {
      this.logger.warn(`Mail queue unavailable: ${(err as Error).message}; falling back to inline sends.`);
      this.queue = null;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close().catch(() => undefined);
    await this.queue?.close().catch(() => undefined);
    this.redis?.disconnect();
  }

  /**
   * Enqueue a message. If the queue is unavailable (Redis down at boot)
   * we send inline so the caller still gets best-effort delivery.
   */
  async enqueue(msg: MailMessage): Promise<void> {
    if (!this.queue) {
      await this.mailer.sendNow(msg).catch((err) => {
        this.logger.warn(`inline send failed: ${(err as Error).message}`);
      });
      return;
    }
    await this.queue.add("send", msg, {
      attempts: ATTEMPTS,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { age: 3600, count: 500 },
      removeOnFail: { age: 24 * 3600 },
    });
  }
}
