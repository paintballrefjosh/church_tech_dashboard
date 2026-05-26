import { Controller, Get, Inject } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { Public } from "../auth/public.decorator";
import { DB, type Db } from "../db/db.module";

@Controller()
export class HealthController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Public()
  @Get("healthz")
  liveness() {
    return { status: "ok", ts: new Date().toISOString() };
  }

  @Public()
  @Get("readyz")
  async readiness() {
    const checks: Record<string, string> = {};
    try {
      await this.db.execute(sql`SELECT 1`);
      checks.db = "ok";
    } catch (err) {
      checks.db = `error: ${(err as Error).message}`;
    }
    const ok = Object.values(checks).every((v) => v === "ok");
    return { status: ok ? "ok" : "degraded", checks, ts: new Date().toISOString() };
  }
}
