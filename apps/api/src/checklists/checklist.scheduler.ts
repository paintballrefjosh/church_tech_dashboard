import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { Inject } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { checklistServices } from "../db/schema";
import { ChecklistsService } from "./checklists.service";
import { ClusterJobs } from "../cluster/cluster-jobs.service";

/**
 * Materialises recurring checklist services into concrete events ahead of time.
 * Runs as a cluster job (one node at a time), shortly after boot and daily
 * thereafter; generation is idempotent (unique
 * serviceId+occurrenceDate), so re-runs only create dates that don't exist yet.
 */
@Injectable()
export class ChecklistScheduler implements OnModuleInit {
  private readonly logger = new Logger(ChecklistScheduler.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly checklists: ChecklistsService,
    private readonly jobs: ClusterJobs,
  ) {}

  onModuleInit(): void {
    // Wait past the readiness probe, then generate; refresh daily.
    this.jobs.register({ name: "checklist-generate", everyMs: 24 * 60 * 60 * 1000, initialDelayMs: 45_000, run: () => this.run() });
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
