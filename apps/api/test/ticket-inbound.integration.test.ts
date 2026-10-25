import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import { INBOUND_KEYS } from "@church/shared";
import { TicketsService } from "../src/tickets/tickets.service";
import { TicketInbound, type InboundConfig } from "../src/tickets/ticket-inbound";
import type { AuthenticatedUser } from "../src/auth/current-user.decorator";
import * as schema from "../src/db/schema";

/**
 * Tickets from email against a real database (TEST_DATABASE_URL, see db-stores.integration.test.ts; it empties the tickets
 * tables) and, when TEST_IMAP is set to `host:imapPort:smtpPort` (a throwaway GreenMail: `greenmail/standalone` with
 * `-Dgreenmail.setup.test.all -Dgreenmail.users=help:secret@church.test`), through a real IMAP server. Run on CockroachDB
 * and YugabyteDB.
 */
const url = process.env.TEST_DATABASE_URL;
const imap = process.env.TEST_IMAP;

const OWN_PERMS = ["tickets:read:own", "tickets:write:own"];
const STAFF_PERMS = [...OWN_PERMS, "tickets:read:any", "tickets:admin"];

const CFG: InboundConfig = {
  enabled: true,
  host: "mail.test",
  port: 993,
  secure: true,
  rejectUnauthorized: true,
  username: "help@church.test",
  password: "pw",
  mailbox: "INBOX",
  address: "help@church.test",
  auth: "off",
  authServer: "",
};

let seq = 0;
interface Eml {
  from?: string;
  subject?: string;
  body?: string;
  html?: string;
  headers?: Record<string, string>;
  messageId?: string | null;
  attachments?: Array<{ name: string; type: string; content: string }>;
}
/** A raw RFC 5322 message. Headers given in `headers` are written first, as a receiving server's own would be. */
function eml(o: Eml = {}): Buffer {
  const id = o.messageId === undefined ? `<m${++seq}-${Date.now()}@church.test>` : o.messageId;
  const lines: string[] = [];
  for (const [k, v] of Object.entries(o.headers ?? {})) lines.push(`${k}: ${v}`);
  lines.push(`From: ${o.from ?? "ana@church.test"}`, "To: help@church.test", `Subject: ${o.subject ?? "Projector is dark"}`);
  if (id) lines.push(`Message-ID: ${id}`);
  lines.push("Date: Sat, 17 Oct 2026 09:00:00 +0000", "MIME-Version: 1.0");
  if (o.attachments?.length) {
    lines.push('Content-Type: multipart/mixed; boundary="B"', "", "--B", 'Content-Type: text/plain; charset="utf-8"', "", o.body ?? "The screen is black.");
    for (const a of o.attachments) {
      lines.push("--B", `Content-Type: ${a.type}; name="${a.name}"`, `Content-Disposition: attachment; filename="${a.name}"`, "Content-Transfer-Encoding: base64", "", Buffer.from(a.content).toString("base64"));
    }
    lines.push("--B--");
  } else if (o.html !== undefined) {
    lines.push('Content-Type: text/html; charset="utf-8"', "", o.html);
  } else {
    lines.push('Content-Type: text/plain; charset="utf-8"', "", o.body ?? "The screen is black.");
  }
  return Buffer.from(lines.join("\r\n"));
}

describe.skipIf(!url)("tickets from email against a real database", () => {
  let pool: Pool;
  let tickets: TicketsService;
  let inbound: TicketInbound;
  let values: Record<string, unknown> = {};
  let state = new Map<string, unknown>();
  let uploads: string[] = [];
  let told: Array<{ kind: string; ticket: number; status: string }> = [];
  let ana = "";
  let sam = "";
  let bob = "";
  let cy = "";
  let off = "";
  let gone = "";
  let pending = "";
  const perms = new Map<string, string[]>();
  const q = (text: string, params: unknown[] = []) => pool.query(text, params);

  const person = (id: string): AuthenticatedUser => ({ id, email: `${id}@test.local`, name: id, permissions: perms.get(id) ?? OWN_PERMS }) as unknown as AuthenticatedUser;
  const count = async (table: string) => Number((await q(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
  const ticketRow = async (id: string) =>
    (await q(`SELECT title, description, status, created_by_user_id AS by, first_response_at AS fr FROM tickets WHERE id = $1`, [id])).rows[0] as {
      title: string; description: string; status: string; by: string; fr: Date | null;
    };
  const comments = async (id: string) =>
    (await q(`SELECT body, kind, is_internal, author_user_id AS by FROM ticket_comments WHERE ticket_id = $1 ORDER BY created_at`, [id])).rows as Array<{ body: string; kind: string; is_internal: boolean; by: string }>;
  const logOf = async (messageIdLike: string) =>
    (await q(`SELECT outcome, reason, ticket_id FROM ticket_inbound_log WHERE message_id LIKE $1`, [messageIdLike])).rows[0] as { outcome: string; reason: string | null; ticket_id: string | null } | undefined;
  const go = (buf: Buffer, cfg: Partial<InboundConfig> = {}) => inbound.processMessage(buf, { ...CFG, ...cfg });

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 5 });
    const db = drizzle(pool, { schema });
    await q(`DELETE FROM users WHERE email LIKE 'hdm-%@test.local'`);
    const mk = async (n: string, extra: { active?: boolean; deleted?: boolean; approval?: string } = {}) => {
      const email = `hdm-${n}@test.local`;
      const id = (
        await q(`INSERT INTO users (email, name, is_active, deleted_at, approval_status) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [
          email, n, extra.active ?? true, extra.deleted ? new Date() : null, extra.approval ?? "approved",
        ])
      ).rows[0].id as string;
      return id;
    };
    ana = await mk("ana");
    sam = await mk("sam");
    bob = await mk("bob");
    cy = await mk("cy");
    off = await mk("off", { active: false });
    gone = await mk("gone", { deleted: true });
    pending = await mk("pending", { approval: "pending" });
    perms.set(sam, STAFF_PERMS);
    perms.set(bob, ["tickets:read:own"]);

    const none = { changed: () => undefined, record: async () => undefined, notify: async () => undefined };
    const attachments = {
      upload: async (_t: string, _id: string, _u: string, f: { filename: string }) => {
        if (/\.exe$/i.test(f.filename)) throw new Error("content-type application/x-msdownload is not allowed for attachments");
        uploads.push(f.filename);
      },
    };
    tickets = new TicketsService(db as never, none as never, none as never, none as never);
    const events = {
      created: () => undefined,
      commented: (_a: unknown, t: { number: number; status: string }, c: { body: string }) => void told.push({ kind: c.body, ticket: t.number, status: t.status }),
    };
    const settings = { get: async (k: string) => values[k] };
    const stateSvc = {
      get: async (_j: string, k: string) => (state.has(k) ? { value: state.get(k), ageMs: 0 } : null),
      set: async (_j: string, k: string, v: unknown) => void state.set(k, v),
    };
    const leases = { withMutex: async (_n: string, _t: number, fn: () => Promise<unknown>) => ({ ran: true as const, value: await fn() }) };
    const auth = {
      loadUserById: async (id: string) => {
        const row = (await q(`SELECT id FROM users WHERE id = $1`, [id])).rows[0];
        return row ? person(id) : null;
      },
    };
    inbound = new TicketInbound(db as never, { register: () => undefined } as never, leases as never, stateSvc as never, settings as never, auth as never, tickets, attachments as never, events as never);
  });
  afterAll(async () => {
    await q(`DELETE FROM ticket_inbound_log`);
    await q(`DELETE FROM tickets`);
    await q(`DELETE FROM users WHERE email LIKE 'hdm-%@test.local'`);
    await pool?.end();
  });
  beforeEach(async () => {
    await q(`DELETE FROM ticket_inbound_log`);
    await q(`DELETE FROM tickets`);
    values = {};
    state = new Map();
    uploads = [];
    told = [];
    seq = 0;
  });

  // The test accounts' addresses.
  const A = () => "hdm-ana@test.local";
  const S = () => "hdm-sam@test.local";

  describe("one message", () => {
    it("opens a ticket for a known sender, titled from the subject", async () => {
      const r = await go(eml({ from: `Ana <${A()}>`, subject: "Re: Projector is dark", body: "Hall B, since Sunday." }));
      expect(r.outcome).toBe("ticket");
      const t = await ticketRow(r.ticketId!);
      expect(t.title).toBe("Projector is dark");
      expect(t.description).toBe("Hall B, since Sunday.");
      expect(t.by).toBe(ana);
      expect(t.status).toBe("open");
      expect((await comments(r.ticketId!)).map((c) => c.body).join("\n")).toContain("opened this ticket by email");
      expect((await logOf("%"))?.outcome).toBe("ticket");
    });

    it("keeps quoted text in a new ticket (a forwarded message is the request)", async () => {
      const body = "See below.\n\n-----Original Message-----\nFrom: x\nSent: y\n\nThe printer jams.";
      const r = await go(eml({ from: A(), body }));
      expect((await ticketRow(r.ticketId!)).description).toBe(body);
    });

    it("handles a message once", async () => {
      const raw = eml({ from: A() });
      expect((await go(raw)).outcome).toBe("ticket");
      expect((await go(raw)).outcome).toBe("duplicate");
      expect(await count("tickets")).toBe(1);
    });

    it("recognises the same message with no Message-ID by its content", async () => {
      const raw = eml({ from: A(), messageId: null });
      expect((await go(raw)).outcome).toBe("ticket");
      expect((await go(raw)).outcome).toBe("duplicate");
      expect(await count("tickets")).toBe(1);
    });

    it("adds a reply to its ticket as a comment without the quoted original", async () => {
      const first = await go(eml({ from: A() }));
      const number = Number((await q(`SELECT number FROM tickets WHERE id = $1`, [first.ticketId])).rows[0].number);
      const r = await go(eml({ from: A(), subject: `Re: Projector is dark [#${number}]`, body: `It works now.\n\nOn Sat, 17 Oct 2026, Help wrote:\n> Did you try the cable?` }));
      expect(r).toMatchObject({ outcome: "comment", ticketId: first.ticketId });
      const c = (await comments(first.ticketId!)).filter((x) => x.kind === "comment");
      expect(c).toHaveLength(1);
      expect(c[0]).toMatchObject({ body: "It works now.", is_internal: false, by: ana });
      expect(told.at(-1)).toMatchObject({ ticket: number });
      expect(await count("tickets")).toBe(1);
    });

    it("lets staff answer by email, and counts it as the first response", async () => {
      const first = await go(eml({ from: A() }));
      const number = Number((await q(`SELECT number FROM tickets WHERE id = $1`, [first.ticketId])).rows[0].number);
      expect((await ticketRow(first.ticketId!)).fr).toBeNull();
      const r = await go(eml({ from: S(), subject: `Re: [#${number}] Projector is dark`, body: "On my way." }));
      expect(r.outcome).toBe("comment");
      expect((await ticketRow(first.ticketId!)).fr).not.toBeNull();
    });

    it("puts a waiting ticket back to work when the requester answers by email", async () => {
      const first = await go(eml({ from: A() }));
      const number = Number((await q(`SELECT number FROM tickets WHERE id = $1`, [first.ticketId])).rows[0].number);
      await q(`UPDATE tickets SET status = 'waiting', waiting_since = now() WHERE id = $1`, [first.ticketId]);
      await go(eml({ from: A(), subject: `Re: [#${number}]`, body: "It is the HDMI cable." }));
      expect((await ticketRow(first.ticketId!)).status).toBe("open");
    });

    it("opens a new ticket when the number is unknown or the ticket is not the sender's to read", async () => {
      expect((await go(eml({ from: A(), subject: "Re: help [#99999]" }))).outcome).toBe("ticket");
      const mine = await go(eml({ from: A() }));
      const number = Number((await q(`SELECT number FROM tickets WHERE id = $1`, [mine.ticketId])).rows[0].number);
      // cy is another ordinary user: they cannot read ana's ticket, so a reply naming it must not become a comment on it.
      const r = await go(eml({ from: "hdm-cy@test.local", subject: `Re: [#${number}] hello`, body: "Me too." }));
      expect(r.outcome).toBe("ticket");
      expect(r.ticketId).not.toBe(mine.ticketId);
      expect((await comments(mine.ticketId!)).filter((c) => c.kind === "comment")).toHaveLength(0);
    });

    it("skips people who are not accounts, are switched off, deleted or still waiting for approval", async () => {
      for (const from of ["stranger@elsewhere.example", "hdm-off@test.local", "hdm-gone@test.local", "hdm-pending@test.local"]) {
        const r = await go(eml({ from }));
        expect(r).toMatchObject({ outcome: "skipped", reason: "unknown_sender" });
      }
      expect(await count("tickets")).toBe(0);
    });

    it("skips an account that may not open tickets", async () => {
      const r = await go(eml({ from: "hdm-bob@test.local" }));
      expect(r).toMatchObject({ outcome: "skipped", reason: "no_access" });
      void cy;
    });

    it("skips automatic mail and the site's own mail", async () => {
      expect(await go(eml({ from: A(), headers: { "Auto-Submitted": "auto-replied" }, subject: "Out of office" }))).toMatchObject({ reason: "auto_generated" });
      expect(await go(eml({ from: A(), headers: { Precedence: "bulk" } }))).toMatchObject({ reason: "auto_generated" });
      expect(await go(eml({ from: "help@church.test" }))).toMatchObject({ reason: "own_mail" });
      values["smtp.from_email"] = "noreply@church.test";
      expect(await go(eml({ from: "noreply@church.test" }))).toMatchObject({ reason: "own_mail" });
      expect(await count("tickets")).toBe(0);
    });

    it("skips an empty message", async () => {
      expect(await go(eml({ from: A(), body: "   " }))).toMatchObject({ reason: "empty" });
    });

    it("turns an HTML-only message into text", async () => {
      const r = await go(eml({ from: A(), html: "<p>The <b>projector</b> is dark.</p><p>Hall B.</p>" }));
      const d = (await ticketRow(r.ticketId!)).description;
      expect(d).toContain("The projector is dark.");
      expect(d).toContain("Hall B.");
      expect(d).not.toContain("<");
    });

    it("cuts a very long message", async () => {
      const r = await go(eml({ from: A(), body: "x".repeat(25_000) }));
      const d = (await ticketRow(r.ticketId!)).description;
      expect(d.length).toBeLessThan(20_000);
      expect(d).toContain("The rest of the message was cut off.");
    });

    it("stores attachments and says which could not be", async () => {
      const r = await go(
        eml({
          from: A(),
          attachments: [
            { name: "photo.png", type: "image/png", content: "png-bytes" },
            { name: "setup.exe", type: "application/x-msdownload", content: "MZ" },
          ],
        }),
      );
      expect(uploads).toEqual(["photo.png"]);
      expect((await comments(r.ticketId!)).map((c) => c.body).join("\n")).toContain("Not attached from the email: setup.exe (file type not allowed)");
    });

    it("stops a sender who writes too much", async () => {
      for (let i = 0; i < 30; i++) {
        await q(`INSERT INTO ticket_inbound_log (message_id, from_address, outcome) VALUES ($1, $2, 'ticket')`, [`seed-${i}`, A()]);
      }
      expect(await go(eml({ from: A() }))).toMatchObject({ outcome: "skipped", reason: "rate_limited" });
      expect((await go(eml({ from: S() }))).outcome).toBe("ticket");
    });
  });

  describe("who the sender really is", () => {
    const gmailPass = "mx.google.com; dkim=pass header.d=test.local; spf=pass smtp.mailfrom=hdm-ana@test.local; dmarc=pass (p=NONE) header.from=test.local";

    it("strict mode refuses mail the server did not confirm, and accepts a DMARC pass", async () => {
      expect(await go(eml({ from: A() }), { auth: "strict" })).toMatchObject({ outcome: "skipped", reason: "not_authenticated" });
      expect((await go(eml({ from: A(), headers: { "Authentication-Results": gmailPass } }), { auth: "strict" })).outcome).toBe("ticket");
    });

    it("refuses a failed DMARC even when DKIM passed (strict)", async () => {
      const h = "mx.google.com; dkim=pass header.d=test.local; dmarc=fail header.from=test.local";
      expect(await go(eml({ from: A(), headers: { "Authentication-Results": h } }), { auth: "strict" })).toMatchObject({ reason: "not_authenticated" });
    });

    it("aligned mode accepts a DKIM pass for the sender's own domain only", async () => {
      const own = "mx.google.com; dkim=pass header.d=test.local";
      const other = "mx.google.com; dkim=pass header.d=evil.example";
      expect((await go(eml({ from: A(), headers: { "Authentication-Results": own } }), { auth: "aligned" })).outcome).toBe("ticket");
      expect(await go(eml({ from: A(), headers: { "Authentication-Results": other } }), { auth: "aligned" })).toMatchObject({ reason: "not_authenticated" });
    });

    it("does not believe a header the sender wrote when the mail server is named", async () => {
      const forged = "evil.example; dmarc=pass header.from=test.local";
      const cfg = { auth: "strict" as const, authServer: "mx.google.com" };
      expect(await go(eml({ from: A(), headers: { "Authentication-Results": forged } }), cfg)).toMatchObject({ reason: "not_authenticated" });
      // The real server's header sits below nothing it did not write: both present, the named one is the one believed.
      const both = Buffer.from(`Authentication-Results: ${gmailPass}\r\nAuthentication-Results: ${forged}\r\n`).toString() + eml({ from: A() }).toString();
      expect((await go(Buffer.from(both), cfg)).outcome).toBe("ticket");
    });
  });
});

describe.skipIf(!url || !imap)("tickets from email through a real IMAP server", () => {
  const [host, imapPort, smtpPort] = (imap ?? "").split(":");
  let pool: Pool;
  let inbound: TicketInbound;
  let values: Record<string, unknown> = {};
  let state = new Map<string, unknown>();
  let ana = "";
  const q = (text: string, params: unknown[] = []) => pool.query(text, params);
  const cfgValues = () => ({
    [INBOUND_KEYS.enabled]: true,
    [INBOUND_KEYS.host]: host,
    [INBOUND_KEYS.port]: Number(imapPort),
    [INBOUND_KEYS.secure]: false,
    [INBOUND_KEYS.rejectUnauthorized]: false,
    [INBOUND_KEYS.username]: "help",
    [INBOUND_KEYS.password]: "secret",
    [INBOUND_KEYS.mailbox]: "INBOX",
    [INBOUND_KEYS.address]: "help@church.test",
    [INBOUND_KEYS.auth]: "off",
  });
  const mailer = () => nodemailer.createTransport({ host, port: Number(smtpPort), secure: false, tls: { rejectUnauthorized: false } });
  const deliver = async (subject: string, text: string, from = "hdm-ana@test.local") => {
    await mailer().sendMail({ from, to: "help@church.test", subject, text });
  };
  const emptyMailbox = async () => {
    const c = new ImapFlow({ host, port: Number(imapPort), secure: false, auth: { user: "help", pass: "secret" }, logger: false });
    c.on("error", () => undefined);
    await c.connect();
    const lock = await c.getMailboxLock("INBOX");
    try {
      if (c.mailbox && c.mailbox.exists > 0) await c.messageDelete("1:*");
    } finally {
      lock.release();
    }
    await c.logout();
  };
  const append = async (subject: string, ageDays: number) => {
    const c = new ImapFlow({ host, port: Number(imapPort), secure: false, auth: { user: "help", pass: "secret" }, logger: false });
    c.on("error", () => undefined);
    await c.connect();
    const raw = `From: hdm-ana@test.local\r\nTo: help@church.test\r\nSubject: ${subject}\r\nMessage-ID: <old-${subject.replace(/\W/g, "")}-${Date.now()}@church.test>\r\n\r\nbody of ${subject}\r\n`;
    await c.append("INBOX", raw, [], new Date(Date.now() - ageDays * 86_400_000));
    await c.logout();
  };
  const titles = async () => (await q(`SELECT title FROM tickets ORDER BY created_at`)).rows.map((r) => r.title as string);

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 5 });
    const db = drizzle(pool, { schema });
    await q(`DELETE FROM users WHERE email LIKE 'hdm-%@test.local'`);
    ana = (await q(`INSERT INTO users (email, name) VALUES ('hdm-ana@test.local', 'ana') RETURNING id`)).rows[0].id as string;
    const none = { changed: () => undefined, record: async () => undefined, notify: async () => undefined };
    const tickets = new TicketsService(db as never, none as never, none as never, none as never);
    const stateSvc = {
      get: async (_j: string, k: string) => (state.has(k) ? { value: state.get(k), ageMs: 0 } : null),
      set: async (_j: string, k: string, v: unknown) => void state.set(k, v),
    };
    const leases = { withMutex: async (_n: string, _t: number, fn: () => Promise<unknown>) => ({ ran: true as const, value: await fn() }) };
    const auth = { loadUserById: async (id: string) => ({ id, email: "hdm-ana@test.local", name: "ana", permissions: OWN_PERMS }) as unknown as AuthenticatedUser };
    const events = { created: () => undefined, commented: () => undefined };
    inbound = new TicketInbound(
      db as never,
      { register: () => undefined } as never,
      leases as never,
      stateSvc as never,
      { get: async (k: string) => values[k] } as never,
      auth as never,
      tickets,
      { upload: async () => undefined } as never,
      events as never,
    );
    void ana;
  });
  afterAll(async () => {
    await q(`DELETE FROM ticket_inbound_log`);
    await q(`DELETE FROM tickets`);
    await q(`DELETE FROM users WHERE email LIKE 'hdm-%@test.local'`);
    await pool?.end();
  });
  beforeEach(async () => {
    await q(`DELETE FROM ticket_inbound_log`);
    await q(`DELETE FROM tickets`);
    values = cfgValues();
    state = new Map();
    await emptyMailbox();
  });

  it("tests the connection", async () => {
    const r = await inbound.test();
    expect(r.ok).toBe(true);
    expect(r.message).toContain("INBOX");
    values[INBOUND_KEYS.password] = "wrong";
    const bad = await inbound.test();
    expect(bad.ok).toBe(false);
    expect(bad.message).not.toContain("wrong");
  });

  it("refuses a server whose certificate it cannot verify, and connects once told not to check", async () => {
    values[INBOUND_KEYS.port] = 3993;
    values[INBOUND_KEYS.secure] = true;
    values[INBOUND_KEYS.rejectUnauthorized] = true;
    const strict = await inbound.test();
    expect(strict.ok).toBe(false);
    expect(strict.message).toMatch(/certificate|self.signed|unable to verify/i);
    values[INBOUND_KEYS.rejectUnauthorized] = false;
    expect((await inbound.test()).ok).toBe(true);
  });

  it("does nothing while switched off, unless forced", async () => {
    values[INBOUND_KEYS.enabled] = false;
    await deliver("Projector is dark", "Hall B.");
    expect((await inbound.run()).state).toBe("off");
    expect(await titles()).toEqual([]);
    expect((await inbound.run({ force: true })).state).toBe("ok");
    expect(await titles()).toEqual(["Projector is dark"]);
  });

  it("takes recent mail on the first look, leaves old mail alone, and handles each message once", async () => {
    await append("Last month's problem", 30);
    await deliver("Projector is dark", "Hall B.");
    await deliver("Wi-Fi is slow", "Foyer.");
    expect(await inbound.run()).toMatchObject({ state: "ok", handled: 2 });
    expect((await titles()).sort()).toEqual(["Projector is dark", "Wi-Fi is slow"]);
    expect(await inbound.run()).toMatchObject({ state: "ok", handled: 0 });
    expect(await titles()).toHaveLength(2);
    await deliver("Printer jams", "Office.");
    expect(await inbound.run()).toMatchObject({ handled: 1 });
    expect(await titles()).toContain("Printer jams");
  });

  it("does not read the mailbox's history after it has once caught up", async () => {
    await deliver("First", "a");
    await inbound.run();
    state.delete("cursor");
    // Losing the position is survivable: the log stops the same messages becoming tickets twice.
    await inbound.run();
    expect(await titles()).toEqual(["First"]);
  });

  it("leaves mail unread and in place", async () => {
    await deliver("Projector is dark", "Hall B.");
    await inbound.run();
    const c = new ImapFlow({ host, port: Number(imapPort), secure: false, auth: { user: "help", pass: "secret" }, logger: false });
    c.on("error", () => undefined);
    await c.connect();
    const lock = await c.getMailboxLock("INBOX");
    try {
      expect(c.mailbox && c.mailbox.exists).toBe(1);
      const unseen = await c.search({ seen: false });
      expect(unseen).toHaveLength(1);
    } finally {
      lock.release();
    }
    await c.logout();
  });

  it("reports a refused login without the password", async () => {
    values[INBOUND_KEYS.password] = "definitely-wrong";
    const r = await inbound.run();
    expect(r.state).toBe("error");
    expect(r.error).toBeTruthy();
    expect(r.error).not.toContain("definitely-wrong");
    const status = await inbound.status();
    expect(status.lastError).toBe(r.error);
  });

  it("reports a server that is not there", async () => {
    values[INBOUND_KEYS.host] = "127.0.0.1";
    values[INBOUND_KEYS.port] = 1;
    const r = await inbound.run();
    expect(r.state).toBe("error");
    expect(r.error).toMatch(/refused|answer/);
  });

  it("summarises the week for the settings page", async () => {
    await deliver("Projector is dark", "Hall B.");
    await deliver("Spam", "buy", "stranger@elsewhere.example");
    await inbound.run();
    const s = await inbound.status();
    expect(s.week).toMatchObject({ ticket: 1, skipped: 1 });
    expect(s.recent.find((r) => r.outcome === "skipped")).toMatchObject({ reason: "unknown_sender", fromAddress: "stranger@elsewhere.example" });
    expect(s.lastOkAt).not.toBeNull();
  });
});
