import { describe, expect, it } from "vitest";
import { ServiceUnavailableException } from "@nestjs/common";
import { HealthController } from "../src/health/health.controller";
import type { Db } from "../src/db/db.module";

// The readiness check reads inside a transaction (so SET LOCAL can bound the query): the fake runs
// the callback with a transaction whose `execute` is the given function.
const controller = (execute: () => Promise<unknown>) =>
  new HealthController({
    transaction: async (fn: (tx: { execute: () => Promise<unknown> }) => Promise<unknown>) => fn({ execute }),
  } as unknown as Db);

describe("readiness (what a load balancer's health check reaches through /healthz)", () => {
  it("answers ok while the database answers", async () => {
    const res = await controller(async () => ({ rows: [{}] })).readiness();
    expect(res.status).toBe("ok");
    expect(res.checks.db).toBe("ok");
  });

  it("answers with a 503, not a 200, when the database cannot be reached", async () => {
    const c = controller(async () => {
      throw new Error("connection refused");
    });
    await expect(c.readiness()).rejects.toBeInstanceOf(ServiceUnavailableException);
    await c.readiness().catch((e: ServiceUnavailableException) => {
      expect(e.getStatus()).toBe(503);
      expect(e.getResponse()).toMatchObject({ status: "degraded", checks: { db: expect.stringContaining("connection refused") } });
    });
  });

  it("answers 503 when the database accepts the connection but never answers a read (no majority)", async () => {
    const c = new HealthController({
      transaction: () => new Promise(() => undefined),
    } as unknown as Db);
    await expect(c.readiness()).rejects.toBeInstanceOf(ServiceUnavailableException);
  }, 10_000);

  it("liveness stays 200 regardless (the container health check must not flap with the database)", () => {
    const res = controller(async () => {
      throw new Error("down");
    }).liveness();
    expect(res.status).toBe("ok");
  });
});
