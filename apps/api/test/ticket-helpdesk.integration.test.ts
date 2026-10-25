import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { TicketsService } from "../src/tickets/tickets.service";
import { TicketSla } from "../src/tickets/ticket-sla";
import { CannedRepliesService } from "../src/tickets/canned-replies.service";
import type { AuthenticatedUser } from "../src/auth/current-user.decorator";
import * as schema from "../src/db/schema";

/**
 * Waiting on the requester, the SLA notices and canned replies against a real database (see
 * db-stores.integration.test.ts for the setup). It empties the tickets tables, so never point it at a database you
 * care about. Run on CockroachDB and YugabyteDB.
 */
const url = process.env.TEST_DATABASE_URL;

interface Sent {
  recipients: string[];
  kind: string;
  title: string;
  body: string;
}

describe.skipIf(!url)("helpdesk waiting, SLA notices and canned replies against a real database", () => {
  let pool: Pool;
  let tickets: TicketsService;
  let sla: TicketSla;
  let canned: CannedRepliesService;
  let values: Record<string, unknown> = {};
  let sent: Sent[] = [];
  let requester = "";
  let staff = "";
  let staff2 = "";
  let outsider = "";
  const q = (text: string, params: unknown[] = []) => pool.query(text, params);

  const person = (id: string, permissions: string[]): AuthenticatedUser =>
    ({ id, email: `${id}@test.local`, name: id, permissions }) as unknown as AuthenticatedUser;
  const ownPerms = ["tickets:read:own", "tickets:write:own"];
  const staffPerms = [...ownPerms, "tickets:read:any", "tickets:admin"];

  const addTicket = async (over: { minutesAgo?: number; status?: string; priority?: string; assignee?: string | null; responded?: boolean } = {}) =>
    (
      await q(
        `INSERT INTO tickets (title, status, priority, created_by_user_id, assigned_user_id, created_at, first_response_at)
         VALUES ('Projector is dark', $1, $2, $3, $4, now() - ($5 || ' minutes')::interval, $6) RETURNING id`,
        [over.status ?? "open", over.priority ?? "normal", requester, over.assignee === undefined ? staff : over.assignee, String(over.minutesAgo ?? 0), over.responded ? new Date() : null],
      )
    ).rows[0].id as string;
  const row = async (id: string) =>
    (
      await q(
        `SELECT status, waiting_since AS ws, waited_ms::text AS waited, response_warned_at AS rw, response_breached_at AS rb,
                resolution_warned_at AS sw, resolution_breached_at AS sb FROM tickets WHERE id = $1`,
        [id],
      )
    ).rows[0] as { status: string; ws: Date | null; waited: string; rw: Date | null; rb: Date | null; sw: Date | null; sb: Date | null };
  const events = async (id: string) =>
    (await q(`SELECT body FROM ticket_comments WHERE ticket_id = $1 AND kind = 'event' ORDER BY created_at`, [id])).rows.map((r) => r.body as string);

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 5 });
    const db = drizzle(pool, { schema });
    await q(`DELETE FROM group_module_access WHERE group_id IN (SELECT id FROM groups WHERE name LIKE 'Helpdesk Test%')`);
    await q(`DELETE FROM group_memberships WHERE group_id IN (SELECT id FROM groups WHERE name LIKE 'Helpdesk Test%')`);
    await q(`DELETE FROM groups WHERE name LIKE 'Helpdesk Test%'`);
    await q(`DELETE FROM users WHERE email LIKE 'hd-%@test.local'`);
    const mk = async (n: string) => (await q(`INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`, [`hd-${n}@test.local`, n])).rows[0].id as string;
    requester = await mk("requester");
    staff = await mk("staff");
    staff2 = await mk("staff2");
    outsider = await mk("outsider");
    const settings = { get: async (k: string) => values[k] };
    const notifications = {
      createMany: async (inputs: Array<{ recipientUserId: string; kind: string; title: string; body?: string }>) => {
        if (inputs.length === 0) return;
        const first = inputs[0]!;
        sent.push({ recipients: inputs.map((i) => i.recipientUserId), kind: first.kind, title: first.title, body: first.body ?? "" });
      },
    };
    const none = { changed: () => undefined, record: async () => undefined, notify: async () => undefined };
    tickets = new TicketsService(db as never, none as never, none as never, none as never);
    sla = new TicketSla(db as never, { register: () => undefined } as never, settings as never, notifications as never);
    canned = new CannedRepliesService(db as never);

    const team = (await q(`INSERT INTO groups (name) VALUES ('Helpdesk Test team') RETURNING id`)).rows[0].id as string;
    await q(`INSERT INTO group_memberships (group_id, user_id) VALUES ($1, $2)`, [team, staff2]);
    await q(`INSERT INTO group_module_access (group_id, module_key, tier) VALUES ($1, 'tickets', 'moderator')`, [team]);
    const plain = (await q(`INSERT INTO groups (name) VALUES ('Helpdesk Test plain') RETURNING id`)).rows[0].id as string;
    await q(`INSERT INTO group_memberships (group_id, user_id) VALUES ($1, $2)`, [plain, outsider]);
    await q(`INSERT INTO group_module_access (group_id, module_key, tier) VALUES ($1, 'tickets', 'user')`, [plain]);
  });
  afterAll(async () => {
    await q(`DELETE FROM tickets`);
    await q(`DELETE FROM ticket_canned_replies`);
    await q(`DELETE FROM group_module_access WHERE group_id IN (SELECT id FROM groups WHERE name LIKE 'Helpdesk Test%')`);
    await q(`DELETE FROM group_memberships WHERE group_id IN (SELECT id FROM groups WHERE name LIKE 'Helpdesk Test%')`);
    await q(`DELETE FROM groups WHERE name LIKE 'Helpdesk Test%'`);
    await q(`DELETE FROM users WHERE email LIKE 'hd-%@test.local'`);
    await pool?.end();
  });
  beforeEach(async () => {
    await q(`DELETE FROM tickets`);
    await q(`DELETE FROM ticket_canned_replies`);
    values = {};
    sent = [];
  });

  describe("waiting on the requester", () => {
    it("starts the pause when staff set waiting, and logs it", async () => {
      const id = await addTicket();
      await tickets.update(person(staff, staffPerms), id, { status: "waiting" });
      const t = await row(id);
      expect(t.status).toBe("waiting");
      expect(t.ws).not.toBeNull();
      expect(t.waited).toBe("0");
      expect((await events(id)).join("\n")).toContain("changed status from open to waiting");
    });

    it("adds the wait to the total when the ticket leaves waiting", async () => {
      const id = await addTicket({ status: "waiting" });
      await q(`UPDATE tickets SET waiting_since = now() - interval '30 minutes' WHERE id = $1`, [id]);
      await tickets.update(person(staff, staffPerms), id, { status: "in_progress" });
      const t = await row(id);
      expect(t.ws).toBeNull();
      const waitedMin = Number(t.waited) / 60_000;
      expect(waitedMin).toBeGreaterThan(29.9);
      expect(waitedMin).toBeLessThan(31);
    });

    it("lets the requester's reply put a waiting ticket back to work", async () => {
      const id = await addTicket({ status: "waiting" });
      await q(`UPDATE tickets SET waiting_since = now() - interval '10 minutes' WHERE id = $1`, [id]);
      await tickets.addComment(person(requester, ownPerms), id, { body: "It is the HDMI cable", isInternal: false });
      const t = await row(id);
      expect(t.status).toBe("in_progress");
      expect(t.ws).toBeNull();
      expect(Number(t.waited)).toBeGreaterThan(9 * 60_000);
      expect((await events(id)).join("\n")).toContain("replied: status changed from waiting to in_progress");
    });

    it("goes back to open when nobody has the ticket", async () => {
      const id = await addTicket({ status: "waiting", assignee: null });
      await tickets.addComment(person(requester, ownPerms), id, { body: "Still dark", isInternal: false });
      expect((await row(id)).status).toBe("open");
    });

    it("does not move the ticket for a staff comment, or for a reply on a ticket that is not waiting", async () => {
      const id = await addTicket({ status: "waiting" });
      await tickets.addComment(person(staff, staffPerms), id, { body: "Any news?", isInternal: false });
      await tickets.addComment(person(staff, staffPerms), id, { body: "note to self", isInternal: true });
      expect((await row(id)).status).toBe("waiting");
      const open = await addTicket();
      await tickets.addComment(person(requester, ownPerms), open, { body: "hello", isInternal: false });
      expect((await row(open)).status).toBe("open");
    });

    it("leaves waiting to staff: the owner cannot set it", async () => {
      const id = await addTicket();
      await expect(tickets.update(person(requester, ownPerms), id, { status: "waiting" })).rejects.toThrow();
    });
  });

  describe("SLA notices", () => {
    const targets = () => {
      values = {
        "tickets.sla.response_min.normal": 100,
        "tickets.sla.resolution_min.normal": 1000,
        "tickets.sla.response_min.urgent": 30,
        "tickets.sla.resolution_min.urgent": 120,
      };
    };

    it("does nothing while every target is off", async () => {
      await addTicket({ minutesAgo: 99999 });
      expect(await sla.run()).toEqual({ warnings: 0, breaches: 0, silent: 0 });
      expect(sent).toEqual([]);
    });

    it("warns the assignee once at 80 percent, then announces the breach once", async () => {
      targets();
      const id = await addTicket({ minutesAgo: 85 });
      expect(await sla.run()).toEqual({ warnings: 1, breaches: 0, silent: 0 });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ recipients: [staff], kind: "ticket.sla_warning" });
      expect(sent[0]!.title).toContain("nearing its first-response target");
      expect(await sla.run()).toEqual({ warnings: 0, breaches: 0, silent: 0 });

      await q(`UPDATE tickets SET created_at = now() - interval '105 minutes' WHERE id = $1`, [id]);
      expect(await sla.run()).toEqual({ warnings: 0, breaches: 1, silent: 0 });
      expect(sent[1]).toMatchObject({ recipients: [staff], kind: "ticket.sla_breached" });
      expect(sent[1]!.title).toContain("missed its first-response target");
      expect(await sla.run()).toEqual({ warnings: 0, breaches: 0, silent: 0 });
      const t = await row(id);
      expect(t.rb).not.toBeNull();
      expect(t.rw).not.toBeNull();
    });

    it("sends only the breach when a ticket is first noticed past its target", async () => {
      targets();
      await addTicket({ minutesAgo: 105 });
      expect(await sla.run()).toEqual({ warnings: 0, breaches: 1, silent: 0 });
      expect(sent.map((s) => s.kind)).toEqual(["ticket.sla_breached"]);
    });

    it("tells the support team when nobody has the ticket, and nobody outside it", async () => {
      targets();
      await addTicket({ minutesAgo: 105, assignee: null });
      await sla.run();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.recipients).toContain(staff2);
      expect(sent[0]!.recipients).not.toContain(outsider);
      expect(sent[0]!.recipients).not.toContain(requester);
    });

    it("flags a breach noticed hours late without announcing it", async () => {
      targets();
      const id = await addTicket({ minutesAgo: 60 * 20 });
      expect(await sla.run()).toEqual({ warnings: 0, breaches: 0, silent: 2 });
      expect(sent).toEqual([]);
      expect((await row(id)).rb).not.toBeNull();
      expect(await sla.run()).toEqual({ warnings: 0, breaches: 0, silent: 0 });
    });

    it("has no clock for a waiting ticket, and starts it again when the ticket is back at work", async () => {
      targets();
      const id = await addTicket({ minutesAgo: 105, status: "waiting" });
      await q(`UPDATE tickets SET waiting_since = now() - interval '100 minutes' WHERE id = $1`, [id]);
      await sla.run();
      expect(sent).toEqual([]);
      // Back at work: the 100 minutes waited do not count, so only 5 have elapsed.
      await tickets.addComment(person(requester, ownPerms), id, { body: "Here is the answer", isInternal: false });
      await sla.run();
      expect(sent).toEqual([]);
    });

    it("counts only the resolution clock once the ticket has had a response", async () => {
      targets();
      await addTicket({ minutesAgo: 900, responded: true });
      await sla.run();
      expect(sent.map((s) => s.title)).toEqual([expect.stringContaining("nearing its resolution target")]);
    });

    it("starts over when the priority changes", async () => {
      targets();
      const id = await addTicket({ minutesAgo: 105 });
      await sla.run();
      expect((await row(id)).rb).not.toBeNull();
      await tickets.update(person(staff, staffPerms), id, { priority: "high" });
      const t = await row(id);
      expect(t.rb).toBeNull();
      expect(t.rw).toBeNull();
    });

    it("clears the resolution notices when a finished ticket is reopened", async () => {
      targets();
      const id = await addTicket({ minutesAgo: 10 });
      await q(`UPDATE tickets SET status = 'resolved', resolved_at = now(), resolution_breached_at = now(), resolution_warned_at = now() WHERE id = $1`, [id]);
      await tickets.update(person(staff, staffPerms), id, { status: "open" });
      const t = await row(id);
      expect(t.sb).toBeNull();
      expect(t.sw).toBeNull();
    });

    it("sends a notice once when two runs overlap", async () => {
      targets();
      await addTicket({ minutesAgo: 105 });
      await Promise.all([sla.run(), sla.run(), sla.run()]);
      expect(sent).toHaveLength(1);
    });

    it("turns warnings off with 0 but still announces breaches", async () => {
      targets();
      values["tickets.sla.warn_percent"] = 0;
      await addTicket({ minutesAgo: 90 });
      await sla.run();
      expect(sent).toEqual([]);
      await q(`UPDATE tickets SET created_at = now() - interval '105 minutes'`);
      await sla.run();
      expect(sent.map((s) => s.kind)).toEqual(["ticket.sla_breached"]);
    });
  });

  describe("canned replies", () => {
    it("creates, edits, lists by title and removes", async () => {
      const b = await canned.create(staff, { title: "Reboot it", body: "Hi {{requester}}, please restart." });
      const a = await canned.create(staff, { title: "Asked for details", body: "Which room?" });
      expect((await canned.list()).map((r) => r.title)).toEqual(["Asked for details", "Reboot it"]);
      const edited = await canned.update(b.id, { body: "Hi {{requester}}, please restart and try again." });
      expect(edited.body).toContain("try again");
      expect(edited.title).toBe("Reboot it");
      await canned.remove(a.id);
      expect(await canned.list()).toHaveLength(1);
      await expect(canned.update(a.id, { title: "x" })).rejects.toThrow(/not found/);
      await expect(canned.remove(a.id)).rejects.toThrow(/not found/);
    });

    it("keeps a reply when the person who wrote it is removed", async () => {
      const gone = (await q(`INSERT INTO users (email) VALUES ('hd-gone@test.local') RETURNING id`)).rows[0].id as string;
      const r = await canned.create(gone, { title: "Kept", body: "text" });
      await q(`DELETE FROM users WHERE id = $1`, [gone]);
      const after = (await canned.list()).find((x) => x.id === r.id);
      expect(after).toBeDefined();
      expect(after!.createdByUserId).toBeNull();
    });
  });
});
