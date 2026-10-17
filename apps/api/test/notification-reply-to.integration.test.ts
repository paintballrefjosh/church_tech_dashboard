import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { INBOUND_KEYS } from "@church/shared";
import { NotificationsService } from "../src/notifications/notifications.service";
import { NotificationDeliveryService } from "../src/notifications/notification-delivery.service";
import { PushService } from "../src/notifications/push.service";
import * as schema from "../src/db/schema";

/**
 * Ticket emails can be answered by replying (see the helpdesk mailbox): their subject carries the ticket token and their
 * Reply-To is the help address, but only while the mailbox is on, and only for notices that ask for it. Needs
 * TEST_DATABASE_URL (see db-stores.integration.test.ts); it deletes the notification rows of its own test users.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("ticket emails carry the reply token", () => {
  let pool: Pool;
  let svc: NotificationsService;
  let values: Record<string, unknown> = {};
  let mails: Array<{ to: string; subject: string; replyTo?: string }> = [];
  let userId = "";
  const q = (text: string, params: unknown[] = []) => pool.query(text, params);

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 3 });
    const db = drizzle(pool, { schema });
    await q(`DELETE FROM users WHERE email = 'rt-user@test.local'`);
    userId = (await q(`INSERT INTO users (email, name) VALUES ('rt-user@test.local', 'rt') RETURNING id`)).rows[0].id as string;
    const mailer = { sendBestEffort: async (m: { to: string; subject: string; replyTo?: string }) => void mails.push(m) };
    const realtime = { toUser: () => undefined };
    const settings = { get: async (k: string) => values[k], publicBaseUrl: async () => "https://help.example.org" };
    svc = new NotificationsService(
      db as never,
      realtime as never,
      mailer as never,
      settings as never,
      new NotificationDeliveryService(db as never, settings as never),
      new PushService(db as never, settings as never),
    );
  });
  afterAll(async () => {
    await q(`DELETE FROM notifications WHERE recipient_user_id = $1`, [userId]);
    await q(`DELETE FROM users WHERE id = $1`, [userId]);
    await pool?.end();
  });
  beforeEach(() => {
    values = {};
    mails = [];
  });

  const notice = { recipientUserId: "", kind: "ticket.comment", title: "New comment on ticket #12", body: "hello", link: "/tickets/x", ticketNumber: 12 };
  const on = () => {
    values[INBOUND_KEYS.enabled] = true;
    values[INBOUND_KEYS.address] = "help@church.org";
  };

  it("adds the token and Reply-To to one notice, and to a batch", async () => {
    on();
    await svc.create({ ...notice, recipientUserId: userId });
    await svc.createMany([{ ...notice, recipientUserId: userId }]);
    expect(mails).toHaveLength(2);
    for (const m of mails) {
      expect(m.subject).toBe("New comment on ticket #12 [#12]");
      expect(m.replyTo).toBe("help@church.org");
    }
  });

  it("leaves the email alone while the mailbox is off, or has no address, or the notice does not ask", async () => {
    await svc.create({ ...notice, recipientUserId: userId });
    values[INBOUND_KEYS.enabled] = true;
    await svc.create({ ...notice, recipientUserId: userId });
    on();
    const { ticketNumber: _omit, ...plain } = notice;
    void _omit;
    await svc.create({ ...plain, recipientUserId: userId });
    expect(mails).toHaveLength(3);
    for (const m of mails) {
      expect(m.subject).toBe("New comment on ticket #12");
      expect(m.replyTo).toBeUndefined();
    }
  });
});
