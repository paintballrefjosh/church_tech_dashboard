import { pgTable, text, timestamp, integer, primaryKey, index } from "drizzle-orm/pg-core";

/**
 * Hourly availability samples per system, written by the availability sampler (Phase 5) and read
 * by the Glass look and the week rail. `samples` counts the checks taken in the hour, `down` how
 * many of them found the system down. `kind` is monitor | infra_target | unifi_device |
 * cisco_switch | dns_node | service_instance; `ref` is that kind's own id. Rebuilt by the sampler, never backed up.
 */
export const availabilityHourly = pgTable(
  "availability_hourly",
  {
    kind: text("kind").notNull(),
    ref: text("ref").notNull(),
    hour: timestamp("hour").notNull(),
    label: text("label").notNull().default(""),
    samples: integer("samples").notNull().default(0),
    down: integer("down").notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.kind, t.ref, t.hour] }),
    hourIdx: index("availability_hourly_hour_idx").on(t.hour),
  }),
);
