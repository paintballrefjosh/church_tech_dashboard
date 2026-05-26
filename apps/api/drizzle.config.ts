import type { Config } from "drizzle-kit";

export default {
  schema: "./src/db/schema/index.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.COCKROACH_URL || "postgresql://root@localhost:26257/church?sslmode=disable",
  },
  // Cockroach is wire-compatible with Postgres but lacks some pg_catalog bits;
  // drizzle-kit handles this with the postgresql dialect.
  verbose: true,
  strict: true,
} satisfies Config;
