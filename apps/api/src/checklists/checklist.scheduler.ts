import { Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from "@nestjs/common";
import { Inject } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { checklistServices } from "../db/schema";
import { ChecklistsService } from "./checklists.service";

/**
 * Materialises recurring checklist services into concrete events ahead of time.
 * Mirrors the UpsService poller shape (OnModuleInit + setInterval). Runs shortly
 * after boot and daily thereafter; generation is idempotent (unique
 * serviceId+occurrenceDate), so re-runs only create dates that don't exist yet.
 */
@Injectable()
export class ChecklistScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChecklistScheduler.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly checklists: ChecklistsService,
  ) {}

  onModuleInit(): void {
    // Wait past the readiness probe, then generate; refresh daily.
    setTimeout(() => void this.run(), 45_000);
    this.timer = setInterval(() => void this.run(), 24 * 60 * 60 * 1000);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async run(): Promise<void> {
    try {
      const services = await this.db
        .select({ id: checklistServices.id })
        .from(checklistServices)
        .where(eq(checklistServices.active, true));
      let created = 0;
      for (const s of services) {
        created += await this.checklists.generateOccurrences(s.id).catch(() => 0);
      }
      if (created > 0) this.logger.log(`generated ${created} checklist occurrence(s)`);
    } catch (err) {
      this.logger.warn(`checklist generation failed: ${(err as Error).message}`);
    }
  }
}
