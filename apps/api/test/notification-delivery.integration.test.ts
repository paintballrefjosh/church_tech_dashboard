import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NotificationDelivery } from "@church/shared";
import { NotificationsService } from "../src/notifications/notifications.service";
import { NotificationDeliveryService } from "../src/notifications/notification-delivery.service";
import { NotificationRelease } from "../src/notifications/notification-release";
import { PushService, type PushSender } from "../src/notifications/push.service";
import * as schema from "../src/db/schema";

/**
 * Quiet hours, the daily summary and push, against a real database (CockroachDB and YugabyteDB). Needs TEST_DATABASE_URL
 * pointing at a migrated scratch database. It creates and deletes users of its own. The site zone is UTC here, and the quiet
 * window is built around the real current time, because `create` reads the clock itself.
 */
const url = process.env.TEST_DATABASE_URL;
const MIN = 60_000;

describe.skipIf(!url)("notification delivery", () => {
  let pool: Pool;
  let svc: NotificationsService;
  let release: NotificationRelease;
  let push: PushService;
  let delivery: NotificationDeliveryService;
  let mails: Array<{ to: string; subject: string; text: string }> = [];
  let pushes: Array<{ endpoint: string; body: string; urgent: boolean }> = [];
  let pushFailure: { statusCode: number } | null = null;
  const settingsValues: Record<string, unknown> = {};
  let a = "";
  let b = "";
  const q = (text: string, params: unknown[] = []) => pool.query(text, params);

  const minutesNow = () => {
    const d = new Date();
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  };
  /** A quiet window that contains the present moment. */
  const quietNow = (): Partial<NotificationDelivery> => ({
    quietEnabled: true,
    quietStart: (minutesNow() + 1440 - 60) % 1440,
    quietEnd: (minutesNow() + 120) % 1440,
  });
  const setDelivery = async (userId: string, v: Partial<NotificationDelivery>) => {
    const cur = await delivery.get(userId);
    await delivery.set(userId, { ...cur, ...v });
  };
  const heldCount = async (userId: string) => Number((await q(`SELECT count(*) AS n FROM notification_held WHERE recipient_user_id = $1`, [userId])).rows[0].n);
  const notice = (userId: string, over: Record<string, unknown> = {}) => ({
    recipientUserId: userId,
    kind: "ticket.comment",
    title: "New comment",
    body: "hello",
    link: "/tickets/1",
    ...over,
  });

  beforeAll(async () => {
    process.env.AUTH_SECRET ??= "test-secret-for-delivery";
    pool = new Pool({ connectionString: url, max: 4 });
    const db = drizzle(pool, { schema });
    await q(`DELETE FROM users WHERE email IN ('nd-a@test.local', 'nd-b@test.local')`);
    a = (await q(`INSERT INTO users (email, name) VALUES ('nd-a@test.local', 'nd a') RETURNING id`)).rows[0].id as string;
    b = (await q(`INSERT INTO users (email, name) VALUES ('nd-b@test.local', 'nd b') RETURNING id`)).rows[0].id as string;
    settingsValues["site.timezone"] = "UTC";
    const settings = { get: async (k: string) => settingsValues[k], publicBaseUrl: async () => "https://help.example.org" };
    const mailer = { sendBestEffort: async (m: { to: string; subject: string; text: string }) => void mails.push(m) };
    const realtime = { toUser: () => undefined };
    delivery = new NotificationDeliveryService(db as never, settings as never);
    push = new PushService(db as never, settings as never);
    const sender: PushSender = async (t, body, o) => {
      if (pushFailure) throw Object.assign(new Error("push service said no"), pushFailure);
      pushes.push({ endpoint: t.endpoint, body, urgent: o.urgent });
    };
    push.useSender(sender);
    svc = new NotificationsService(db as never, realtime as never, mailer as never, settings as never, delivery, push);
    release = new NotificationRelease(db as never, { register: () => undefined } as never, delivery, svc, mailer as never);
  });
  afterAll(async () => {
    await q(`DELETE FROM users WHERE id IN ($1, $2)`, [a, b]);
    await pool?.end();
  });
  beforeEach(async () => {
    mails = [];
    pushes = [];
    pushFailure = null;
    for (const id of [a, b]) {
      await q(`DELETE FROM notification_held WHERE recipient_user_id = $1`, [id]);
      await q(`DELETE FROM notifications WHERE recipient_user_id = $1`, [id]);
      await q(`DELETE FROM notification_delivery WHERE user_id = $1`, [id]);
      await q(`DELETE FROM notification_prefs WHERE user_id = $1`, [id]);
      await q(`DELETE FROM push_subscriptions WHERE user_id = $1`, [id]);
    }
  });

  describe("quiet hours", () => {
    it("sends at once when nothing is set (the old behaviour)", async () => {
      await svc.create(notice(a));
      expect(mails).toHaveLength(1);
      expect(await heldCount(a)).toBe(0);
    });

    it("holds the email but still writes the bell row, and releases it after the window", async () => {
      await setDelivery(a, quietNow());
      await svc.create(notice(a));
      expect(mails).toHaveLength(0);
      expect(await heldCount(a)).toBe(1);
      expect(Number((await q(`SELECT count(*) AS n FROM notifications WHERE recipient_user_id = $1`, [a])).rows[0].n)).toBe(1);

      // Still inside the window: nothing to release.
      expect((await release.run(new Date(Date.now() + 10 * MIN))).emails).toBe(0);
      expect(mails).toHaveLength(0);
      // Three hours on, the window (it ends in two) is over.
      const run = await release.run(new Date(Date.now() + 180 * MIN));
      expect(run).toEqual({ people: 1, emails: 1, notices: 1 });
      expect(mails).toHaveLength(1);
      expect(mails[0]!.subject).toBe("New comment");
      expect(await heldCount(a)).toBe(0);
    });

    it("sends what piled up as ONE summary", async () => {
      await setDelivery(a, quietNow());
      await svc.createMany([notice(a, { title: "First" }), notice(a, { title: "Second", kind: "wiki.updated" }), notice(a, { title: "Third", kind: "mention" })]);
      expect(mails).toHaveLength(0);
      expect(await heldCount(a)).toBe(3);
      await release.run(new Date(Date.now() + 180 * MIN));
      expect(mails).toHaveLength(1);
      expect(mails[0]!.subject).toContain("3 notifications while you were away");
      for (const t of ["First", "Second", "Third"]) expect(mails[0]!.text).toContain(t);
      expect(mails[0]!.text).toContain("https://help.example.org/tickets/1");
    });

    it("lets an urgent alert straight through, unless the person turned that off", async () => {
      await setDelivery(a, quietNow());
      await svc.create(notice(a, { kind: "monitor.incident.opened", title: "Printer is down" }));
      expect(mails.map((m) => m.subject)).toEqual(["Printer is down"]);
      mails = [];
      await setDelivery(a, { urgentThrough: false });
      await svc.create(notice(a, { kind: "monitor.incident.opened", title: "Printer is down again" }));
      expect(mails).toHaveLength(0);
      expect(await heldCount(a)).toBe(1);
    });

    it("applies a change of mind to what is already waiting", async () => {
      await setDelivery(a, quietNow());
      await svc.create(notice(a));
      expect(await heldCount(a)).toBe(1);
      await setDelivery(a, { quietEnabled: false });
      await release.run();
      expect(mails).toHaveLength(1);
      expect(await heldCount(a)).toBe(0);
    });

    it("sends a held notice once however many nodes run the job", async () => {
      await setDelivery(a, quietNow());
      await svc.create(notice(a));
      const later = new Date(Date.now() + 180 * MIN);
      await Promise.all([release.run(later), release.run(later), release.run(later)]);
      expect(mails).toHaveLength(1);
    });

    it("sends nothing to an account that has been disabled meanwhile", async () => {
      await setDelivery(b, quietNow());
      await svc.create(notice(b));
      await q(`UPDATE users SET is_active = false WHERE id = $1`, [b]);
      try {
        await release.run(new Date(Date.now() + 180 * MIN));
        expect(mails).toHaveLength(0);
        expect(await heldCount(b)).toBe(0);
      } finally {
        await q(`UPDATE users SET is_active = true WHERE id = $1`, [b]);
      }
    });

    it("lets go of anything held for days, whatever the settings say", async () => {
      await setDelivery(a, { ...quietNow(), urgentThrough: false });
      await q(`INSERT INTO notification_held (recipient_user_id, kind, title, created_at) VALUES ($1, 'ticket.comment', 'Old news', now() - interval '4 days')`, [a]);
      await release.run();
      expect(mails).toHaveLength(1);
    });
  });

  describe("daily summary", () => {
    it("holds email until the summary time, then sends one email", async () => {
      // A summary time that has just passed, so the next one is about a day away.
      await setDelivery(a, { digestEnabled: true, digestAt: (minutesNow() + 1440 - 5) % 1440 });
      await svc.createMany([notice(a, { title: "One" }), notice(a, { title: "Two" })]);
      expect(mails).toHaveLength(0);
      expect((await release.run(new Date(Date.now() + 12 * 60 * MIN))).emails).toBe(0);
      await release.run(new Date(Date.now() + 25 * 60 * MIN));
      expect(mails).toHaveLength(1);
      expect(mails[0]!.subject).toContain("Your summary: 2 notifications");
    });

    it("does not wait for the summary on an urgent alert", async () => {
      await setDelivery(a, { digestEnabled: true, digestAt: (minutesNow() + 1440 - 5) % 1440 });
      await svc.create(notice(a, { kind: "cluster.node_down", title: "Node 2 stopped" }));
      expect(mails).toHaveLength(1);
    });
  });

  describe("push", () => {
    const sub = (n: number) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/device-${n}`, keys: { p256dh: "p", auth: "a" } });
    const prefs = (userId: string, kind: string, channels: string[]) =>
      q(`INSERT INTO notification_prefs (user_id, kind, channels) VALUES ($1, $2, $3)`, [userId, kind, channels]);

    it("pushes to every device of someone who chose push for the kind, and not otherwise", async () => {
      await push.subscribe(a, sub(1), "Mozilla/5.0 Firefox/130.0");
      await push.subscribe(a, sub(2), "Mozilla/5.0 Chrome/130.0");
      await svc.create(notice(a)); // no push choice for this kind
      await new Promise((r) => setTimeout(r, 100));
      expect(pushes).toHaveLength(0);
      expect(mails).toHaveLength(1); // the default channels: bell and email
      mails = [];

      await prefs(a, "ticket.comment", ["in_app", "push"]);
      await svc.create(notice(a, { title: "Printer jam", body: "Room 4" }));
      await new Promise((r) => setTimeout(r, 200));
      expect(pushes).toHaveLength(2);
      const payload = JSON.parse(pushes[0]!.body) as { title: string; body: string; url: string; kind: string };
      expect(payload).toMatchObject({ title: "Printer jam", body: "Room 4", url: "/tickets/1", kind: "ticket.comment" });
      expect(mails).toHaveLength(0); // email was not among the channels
    });

    it("does not push during quiet hours, but pushes an urgent alert", async () => {
      await push.subscribe(a, sub(1), "x");
      await prefs(a, "ticket.comment", ["in_app", "push"]);
      await prefs(a, "monitor.incident.opened", ["in_app", "push"]);
      await setDelivery(a, quietNow());
      await svc.create(notice(a));
      await svc.create(notice(a, { kind: "monitor.incident.opened", title: "Printer is down" }));
      await new Promise((r) => setTimeout(r, 200));
      expect(pushes).toHaveLength(1);
      expect(pushes[0]!.urgent).toBe(true);
      expect(JSON.parse(pushes[0]!.body).title).toBe("Printer is down");
    });

    it("also pushes from a batch, to the right people only", async () => {
      await push.subscribe(a, sub(1), "x");
      await prefs(a, "wiki.updated", ["in_app", "push"]);
      await prefs(b, "wiki.updated", ["in_app", "push"]); // b has no device
      await svc.createMany([notice(a, { kind: "wiki.updated" }), notice(b, { kind: "wiki.updated" })]);
      await new Promise((r) => setTimeout(r, 200));
      expect(pushes.map((p) => p.endpoint)).toEqual([sub(1).endpoint]);
    });

    it("forgets a device the push service says is gone, and keeps one that merely failed", async () => {
      await push.subscribe(a, sub(1), "x");
      await push.subscribe(a, sub(2), "y");
      pushFailure = { statusCode: 500 };
      let out = await push.send([a], { title: "t", body: "b", url: "/", kind: "k" });
      expect(out).toMatchObject({ sent: 0, failed: 2, removed: 0 });
      const errors = (await push.list(a)).map((d) => d.lastError);
      expect(errors).toHaveLength(2);
      expect(errors.every((e) => e?.startsWith("500"))).toBe(true);

      pushFailure = { statusCode: 410 };
      out = await push.send([a], { title: "t", body: "b", url: "/", kind: "k" });
      expect(out.removed).toBe(2);
      expect(await push.list(a)).toHaveLength(0);
    });

    it("moves a browser to whoever subscribes on it next, and lets people remove only their own", async () => {
      const { id } = await push.subscribe(a, sub(1), "x");
      await push.subscribe(b, sub(1), "x"); // same browser, another person signed in
      expect(await push.list(a)).toHaveLength(0);
      expect(await push.list(b)).toHaveLength(1);
      expect(await push.remove(a, id)).toBe(false);
      expect(await push.remove(b, id)).toBe(true);
    });

    it("does nothing at all while the site has push switched off", async () => {
      await push.subscribe(a, sub(1), "x");
      settingsValues["notifications.push_enabled"] = false;
      try {
        const out = await push.send([a], { title: "t", body: "b", url: "/", kind: "k" });
        expect(out).toEqual({ sent: 0, removed: 0, failed: 0 });
        expect(pushes).toHaveLength(0);
      } finally {
        delete settingsValues["notifications.push_enabled"];
      }
    });
  });
});
