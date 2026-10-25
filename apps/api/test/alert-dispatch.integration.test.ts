import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../src/db/schema";
import { AlertChannelsService } from "../src/alerts/alert-channels.service";
import { AlertDispatch } from "../src/alerts/alert-dispatch";

/**
 * The alert outbox against a real database (CockroachDB and YugabyteDB, `TEST_DATABASE_URL` pointing at a migrated scratch
 * database; it empties alert_channels and alert_outbox). A local HTTP server plays the webhook receiver.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("alert dispatch against a real database", () => {
  let pool: Pool;
  let server: Server;
  let hookUrl = "";
  const received: Array<{ headers: Record<string, unknown>; body: Record<string, unknown> }> = [];
  const fannedOut: Array<Array<Record<string, unknown>>> = [];
  let channels: AlertChannelsService;
  let dispatch: AlertDispatch;
  const q = (text: string, params: unknown[] = []) => pool.query(text, params);

  beforeAll(async () => {
    process.env.AUTH_SECRET ??= "test-secret-for-alert-dispatch-integration";
    pool = new Pool({ connectionString: url, max: 4 });
    const db = drizzle(pool, { schema });
    server = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        received.push({ headers: req.headers, body: JSON.parse(data || "{}") });
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    hookUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
    const settings = { get: async (k: string) => (k === "site.name" ? "Test Church" : undefined), publicBaseUrl: async () => "https://dash.test" };
    const notifications = { createMany: async (rows: Array<Record<string, unknown>>) => void fannedOut.push(rows) };
    const infra = { monitoringRecipientIds: async () => ["u1", "u2"] };
    const jobs = { register: () => undefined };
    channels = new AlertChannelsService(db as never, settings as never);
    dispatch = new AlertDispatch(db as never, jobs as never, notifications as never, infra as never, settings as never, channels);
  });
  afterAll(async () => {
    await new Promise((r) => server?.close(r));
    await pool?.end();
  });
  beforeEach(async () => {
    await q("DELETE FROM alert_outbox");
    await q("DELETE FROM alert_channels");
    received.length = 0;
    fannedOut.length = 0;
  });

  it("a worker alert reaches the people (through NotificationsService) and the channels, once", async () => {
    await channels.create({ name: "Hook", type: "webhook", enabled: true, events: "outages", config: { url: hookUrl }, secret: "sig" });
    await q(`INSERT INTO alert_outbox (kind, title, body, link, fanout) VALUES ('monitor.incident.opened', 'Encoder is down', 'timeout', '/monitoring/x', true)`);
    expect(await dispatch.runOnce()).toMatchObject({ sent: 1, stale: 0 });
    expect(fannedOut).toHaveLength(1);
    expect(fannedOut[0]!.map((r) => r.recipientUserId)).toEqual(["u1", "u2"]);
    expect(fannedOut[0]![0]).toMatchObject({ alertChannels: false, title: "Encoder is down" });
    expect(fannedOut[0]![0]!.email).toBeUndefined();
    expect(received).toHaveLength(1);
    expect(received[0]!.body).toMatchObject({ kind: "monitor.incident.opened", url: "https://dash.test/monitoring/x", site: "Test Church" });
    expect(String(received[0]!.headers["x-church-signature"])).toMatch(/^sha256=[0-9a-f]{64}$/);
    // Sent: a second run sends nothing more.
    expect(await dispatch.runOnce()).toMatchObject({ sent: 0 });
    expect(received).toHaveLength(1);
    const [ch] = await channels.list();
    expect(ch!.lastSentAt).not.toBeNull();
    expect(ch!.hasSecret).toBe(true);
  });

  it("an old alert goes to the bell only: no email, push or channel", async () => {
    await channels.create({ name: "Hook", type: "webhook", enabled: true, events: "outages", config: { url: hookUrl } });
    await q(`INSERT INTO alert_outbox (kind, title, fanout, created_at) VALUES ('monitor.incident.opened', 'Old', true, now() - interval '2 hours')`);
    expect(await dispatch.runOnce()).toMatchObject({ sent: 1, stale: 1 });
    expect(fannedOut[0]![0]).toMatchObject({ email: false, push: false });
    expect(received).toHaveLength(0);
  });

  it("an API alert (not fanout) goes to the channels only, and only to those that want its kind", async () => {
    await channels.create({ name: "Outages", type: "webhook", enabled: true, events: "outages", config: { url: hookUrl } });
    await channels.create({ name: "Off", type: "webhook", enabled: false, events: "everything", config: { url: hookUrl } });
    await q(`INSERT INTO alert_outbox (kind, title, fanout) VALUES ('cisco.config_change', 'Config changed', false)`);
    await q(`INSERT INTO alert_outbox (kind, title, fanout) VALUES ('infra.alert.opened', 'Disk full', false)`);
    await dispatch.runOnce();
    expect(fannedOut).toHaveLength(0);
    expect(received.map((r) => r.body.title)).toEqual(["Disk full"]);
  });

  it("a row someone else holds, or one that gave up, is not taken", async () => {
    await q(`INSERT INTO alert_outbox (kind, title, fanout, claimed_until) VALUES ('monitor.incident.opened', 'Held', true, now() + interval '1 minute')`);
    await q(`INSERT INTO alert_outbox (kind, title, fanout, attempts) VALUES ('monitor.incident.opened', 'Gave up', true, 5)`);
    expect(await dispatch.claim()).toHaveLength(0);
    await q(`UPDATE alert_outbox SET claimed_until = now() - interval '1 second' WHERE title = 'Held'`);
    const taken = await dispatch.claim();
    expect(taken.map((r) => r.title)).toEqual(["Held"]);
    expect(taken[0]!.attempts).toBe(1);
    expect(await dispatch.claim()).toHaveLength(0);
  });

  it("a failing channel is recorded on it and does not stop the alert being marked sent", async () => {
    await channels.create({ name: "Dead", type: "webhook", enabled: true, events: "outages", config: { url: "http://127.0.0.1:9/nothing" } });
    await q(`INSERT INTO alert_outbox (kind, title, fanout) VALUES ('monitor.incident.opened', 'Down', false)`);
    expect(await dispatch.runOnce()).toMatchObject({ sent: 1 });
    const [ch] = await channels.list();
    expect(ch!.lastError).toBeTruthy();
    expect(Number((await q(`SELECT count(*) AS n FROM alert_outbox WHERE sent_at IS NULL`)).rows[0].n)).toBe(0);
  });
});
