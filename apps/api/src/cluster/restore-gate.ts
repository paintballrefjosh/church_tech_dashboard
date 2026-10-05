import { CanActivate, ExecutionContext, HttpException, HttpStatus, Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";
import { restoreInProgress } from "@church/shared/db";
import { DB_POOL } from "../db/db.module";

/** How long an answer is believed. Short, so a restore starting or ending is noticed within a second. */
const CACHE_MS = 1000;

/**
 * Whether a backup restore is rewriting the database right now, on any node (the restore holds
 * the `mutex:restore` lease). While it is, writers stand back: the API refuses changes
 * ({@link RestoreWriteGuard}), periodic jobs skip their runs (ClusterJobs) and the monitor worker
 * pauses. Fails open: if the database cannot be asked, nothing is blocked on a guess.
 */
@Injectable()
export class RestoreGate {
  private cached: { at: number; value: boolean } | null = null;

  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async isRestoring(): Promise<boolean> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < CACHE_MS) return this.cached.value;
    try {
      const value = await restoreInProgress(this.pool);
      this.cached = { at: now, value };
      return value;
    } catch {
      return false;
    }
  }

  /** Forget the cached answer (the node running the restore uses this the moment it starts and ends). */
  reset(): void {
    this.cached = null;
  }
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Refuses every change while a restore is running; reads (progress included) keep working. */
@Injectable()
export class RestoreWriteGuard implements CanActivate {
  constructor(private readonly gate: RestoreGate) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== "http") return true;
    const req = context.switchToHttp().getRequest<{ method?: string }>();
    if (READ_METHODS.has((req.method ?? "GET").toUpperCase())) return true;
    if (!(await this.gate.isRestoring())) return true;
    throw new HttpException(
      { statusCode: 503, error: "Service Unavailable", message: "A backup is being restored. Changes are paused for a few minutes; please try again shortly." },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}
