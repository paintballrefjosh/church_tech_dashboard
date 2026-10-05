import { Module, Global, type OnApplicationShutdown, Inject } from "@nestjs/common";
import type { Pool } from "pg";
import { createPool } from "@church/shared/db";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";
import { databaseUrl } from "./connection";

export const DB = Symbol("DB");
export const DB_POOL = Symbol("DB_POOL");

export type Db = NodePgDatabase<typeof schema>;

@Global()
@Module({
  providers: [
    {
      provide: DB_POOL,
      useFactory: () => {
        return createPool({ name: "api", url: databaseUrl(), max: 10 });
      },
    },
    {
      provide: DB,
      inject: [DB_POOL],
      useFactory: (pool: Pool): Db => drizzle(pool, { schema }),
    },
  ],
  exports: [DB, DB_POOL],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}
  // After every module's onModuleDestroy, so those hooks can still use the
  // database (the cluster module releases its leases there).
  async onApplicationShutdown() {
    await this.pool.end();
  }
}
