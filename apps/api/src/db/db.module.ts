import { Module, Global, type OnModuleDestroy, Inject } from "@nestjs/common";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

export const DB = Symbol("DB");
export const DB_POOL = Symbol("DB_POOL");

export type Db = NodePgDatabase<typeof schema>;

@Global()
@Module({
  providers: [
    {
      provide: DB_POOL,
      useFactory: () => {
        const url = process.env.COCKROACH_URL;
        if (!url) throw new Error("COCKROACH_URL is not set");
        return new Pool({ connectionString: url, max: 10 });
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
export class DbModule implements OnModuleDestroy {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}
  async onModuleDestroy() {
    await this.pool.end();
  }
}
