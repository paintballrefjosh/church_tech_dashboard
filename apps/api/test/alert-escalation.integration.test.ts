import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { ALERT_KEYS, MAINTENANCE_MODE_KEY } from "@church/shared";
import { AlertEscalation } from "../src/monitors/alert-escalation";
import { MonitorsService } from "../src/monitors/monitors.service";
import { StatusService } from "../src/monitors/status.service";
import * as schema from "../src/db/schema";

/**
 * Escalation of unacknowledged incidents, acknowledging them and the status page, against a real database (see
 * db-stores.integration.test.ts for the setup). It empties monitors and incidents, so never point it at a database
 * you care about. Run on CockroachDB and YugabyteDB.
 */
const url = process.env.TEST_DATABASE_URL;

interface Sent {
  recipients: string[];
  kind: string;
  title: string;
  link: string | null;
  body: string;
}

describe.skipIf(!url)("alert escalation, acknowledgement and status page against a real database", () => {
  let pool: Pool;
  let escalation: AlertEscalation;
  let monitorsService: MonitorsService;
  let status: StatusService;
  let values: Record<string, unknown> = {};
  let sent: Sent[] = [];
  let activities: string[] = [];
  let usual: string[] = [];
  let userA = "";
  let userB = "";
  let userC = "";
  const q = (text: string, params: unknown[] = []) => pool.query(text, params);

  const addMonitor = async (name: string, over: { status?: string; show?: boolean; statusName?: string; flapping?: boolean; enabled?: boolean } = {}) =>
    (
      await q(
        `INSERT INTO monitors (name, kind, target, status, show_on_status, status_name, flapping_since, enabled)
         VALUES ($1, 'tcp', '10.9.9.9:22', $2, $3, $4, $5, $6) RETURNING id`,
        [name, over.status ?? "down", over.show ?? false, over.statusName ?? null, over.flapping ? new Date() : null, over.enabled ?? true],
      )
    ).rows[0].id as string;
  const addIncident = async (monitorId: string, minutesAgo: number, over: { resolved?: boolean; acked?: boolean; level?: number } = {}) =>
    (
      await q(
        `INSERT INTO monitor_incidents (monitor_id, started_at, resolved_at, acknowledged_at, escalation_level, reason)
         VALUES ($1, now() - ($2 || ' minutes')::interval, $3, $4, $5, 'connection refused') RETURNING id`,
        [monitorId, String(minutesAgo), over.resolved ? new Date() : null, over.acked ? new Date() : null, over.level ?? 0],
      )
    ).rows[0].id as string;
  const level = async (id: string) => Number((await q(`SELECT escalation_level AS l FROM monitor_incidents WHERE id = $1`, [id])).rows[0].l);

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 5 });
    const db = drizzle(pool, { schema });
    await q(`DELETE FROM group_memberships WHERE group_id IN (SELECT id FROM groups WHERE name = 'Escalation Test')`);
    await q(`DELETE FROM groups WHERE name = 'Escalation Test'`);
    await q(`DELETE FROM users WHERE email LIKE 'escal-%@test.local'`);
    const mk = async (n: string) => (await q(`INSERT INTO users (email) VALUES ($1) RETURNING id`, [`escal-${n}@test.local`])).rows[0].id as string;
    userA = await mk("a");
    userB = await mk("b");
    userC = await mk("c");
    const settings = { get: async (k: string) => values[k] };
    const notifications = {
      createMany: async (inputs: Array<{ recipientUserId: string; kind: string; title: string; body?: string; link?: string | null }>) => {
        if (inputs.length === 0) return;
        const first = inputs[0]!;
        sent.push({ recipients: inputs.map((i) => i.recipientUserId), kind: first.kind, title: first.title, link: first.link ?? null, body: first.body ?? "" });
      },
    };
    const activity = { record: async (a: { action: string }) => void activities.push(a.action) };
    const infra = { monitoringRecipientIds: async () => usual };
    const jobs = { register: () => undefined };
    escalation = new AlertEscalation(db as never, jobs as never, settings as never, notifications as never, activity as never, infra as never);
    monitorsService = new MonitorsService(db as never);
    status = new StatusService(db as never, settings as never);
  });
  afterAll(async () => {
    await q(`DELETE FROM monitors`);
    await q(`DELETE FROM group_memberships WHERE group_id IN (SELECT id FROM groups WHERE name = 'Escalation Test')`);
    await q(`DELETE FROM groups WHERE name = 'Escalation Test'`);
    await q(`DELETE FROM users WHERE email LIKE 'escal-%@test.local'`);
    await pool?.end();
  });
  beforeEach(async () => {
    await q(`DELETE FROM monitors`);
    values = {};
    sent = [];
    activities = [];
    usual = [userA];
  });

  const withGroup = async (members: string[]) => {
    await q(`DELETE FROM group_memberships WHERE group_id IN (SELECT id FROM groups WHERE name = 'Escalation Test')`);
    await q(`DELETE FROM groups WHERE name = 'Escalation Test'`);
    const id = (await q(`INSERT INTO groups (name) VALUES ('Escalation Test') RETURNING id`)).rows[0].id as string;
    for (const m of members) await q(`INSERT INTO group_memberships (group_id, user_id) VALUES ($1, $2)`, [id, m]);
  };

  it("sends nothing while both steps are off", async () => {
    const m = await addMonitor("Web");
    await addIncident(m, 500);
    expect(await escalation.run()).toEqual({ reminders: 0, escalations: 0 });
    expect(sent).toEqual([]);
  });

  it("reminds the usual recipients once when the reminder is due, and never again", async () => {
    values = { [ALERT_KEYS.reminderAfterMin]: 15 };
    const m = await addMonitor("Web");
    const early = await addIncident(m, 5);
    const due = await addIncident(await addMonitor("Mail"), 20);
    const r = await escalation.run();
    expect(r).toEqual({ reminders: 1, escalations: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.recipients).toEqual([userA]);
    expect(sent[0]!.kind).toBe("monitor.incident.escalated");
    expect(sent[0]!.title).toBe("Still unresolved: Mail");
    expect(sent[0]!.body).toContain("20 minutes");
    expect(await level(due)).toBe(1);
    expect(await level(early)).toBe(0);
    expect(activities).toEqual(["monitor.incident.escalated"]);
    // The same step is not sent twice.
    expect(await escalation.run()).toEqual({ reminders: 0, escalations: 0 });
    expect(sent).toHaveLength(1);
  });

  it("one winner when two runs race for the same step", async () => {
    values = { [ALERT_KEYS.reminderAfterMin]: 5 };
    await addIncident(await addMonitor("Web"), 30);
    const [a, b] = await Promise.all([escalation.run(), escalation.run()]);
    expect(a.reminders + b.reminders).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("stops for an acknowledged or resolved incident", async () => {
    values = { [ALERT_KEYS.reminderAfterMin]: 5 };
    await addIncident(await addMonitor("A"), 30, { acked: true });
    await addIncident(await addMonitor("B", { status: "up" }), 30, { resolved: true });
    expect(await escalation.run()).toEqual({ reminders: 0, escalations: 0 });
  });

  it("tells the second group, and both groups when the reminder never went out", async () => {
    await withGroup([userB, userC]);
    values = { [ALERT_KEYS.groupAfterMin]: 60, [ALERT_KEYS.escalationGroup]: "Escalation Test" };
    const id = await addIncident(await addMonitor("Web"), 90);
    expect(await escalation.run()).toEqual({ reminders: 0, escalations: 1 });
    expect(sent[0]!.recipients.sort()).toEqual([userA, userB, userC].sort());
    expect(sent[0]!.link).toBe("/status");
    expect(sent[0]!.title).toBe("Needs attention: Web");
    expect(await level(id)).toBe(2);
  });

  it("after a reminder, only the second group is told", async () => {
    await withGroup([userB]);
    values = { [ALERT_KEYS.reminderAfterMin]: 15, [ALERT_KEYS.groupAfterMin]: 60, [ALERT_KEYS.escalationGroup]: "Escalation Test" };
    const id = await addIncident(await addMonitor("Web"), 90, { level: 1 });
    await escalation.run();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.recipients).toEqual([userB]);
    expect(await level(id)).toBe(2);
  });

  it("falls back to reminders when the group is missing or empty", async () => {
    values = { [ALERT_KEYS.reminderAfterMin]: 15, [ALERT_KEYS.groupAfterMin]: 60, [ALERT_KEYS.escalationGroup]: "No Such Group" };
    await addIncident(await addMonitor("Web"), 90);
    const r = await escalation.run();
    expect(r).toEqual({ reminders: 1, escalations: 0 });
    expect(sent[0]!.recipients).toEqual([userA]);
  });

  it("does nothing during maintenance, then catches up", async () => {
    values = { [ALERT_KEYS.reminderAfterMin]: 5, [MAINTENANCE_MODE_KEY]: true };
    const id = await addIncident(await addMonitor("Web"), 30);
    expect(await escalation.run()).toEqual({ reminders: 0, escalations: 0 });
    expect(await level(id)).toBe(0);
    values[MAINTENANCE_MODE_KEY] = false;
    expect(await escalation.run()).toEqual({ reminders: 1, escalations: 0 });
  });

  it("leaves an incident older than three days alone", async () => {
    values = { [ALERT_KEYS.reminderAfterMin]: 5 };
    await addIncident(await addMonitor("Web"), 60 * 24 * 4);
    expect(await escalation.run()).toEqual({ reminders: 0, escalations: 0 });
  });

  it("covers infrastructure alerts too", async () => {
    values = { [ALERT_KEYS.reminderAfterMin]: 5 };
    const t = (
      await q(`INSERT INTO infra_targets (name, kind, host) VALUES ('Proxmox 1', 'proxmox', '10.9.9.8') RETURNING id`)
    ).rows[0].id as string;
    await q(
      `INSERT INTO monitor_incidents (target_id, rule_id, started_at, reason) VALUES ($1, 'r1', now() - interval '30 minutes', 'cpu > 90')`,
      [t],
    );
    const r = await escalation.run();
    expect(r.reminders).toBe(1);
    expect(sent[0]!.title).toBe("Still unresolved: Proxmox 1");
    expect(sent[0]!.link).toBe(`/monitoring/infra/${t}`);
    await q(`DELETE FROM infra_targets WHERE id = $1`, [t]);
  });

  describe("acknowledging", () => {
    it("records who took it, ends the escalation, and is harmless twice", async () => {
      values = { [ALERT_KEYS.reminderAfterMin]: 5 };
      const id = await addIncident(await addMonitor("Web"), 30);
      const first = await monitorsService.acknowledgeIncident(id, userB);
      expect(first.acknowledgedBy).toBe(userB);
      expect(first.acknowledgedAt).toBeTruthy();
      const again = await monitorsService.acknowledgeIncident(id, userC);
      expect(again.acknowledgedBy).toBe(userB);
      expect(await escalation.run()).toEqual({ reminders: 0, escalations: 0 });
    });
    it("refuses an unknown or ended incident", async () => {
      await expect(monitorsService.acknowledgeIncident("00000000-0000-4000-8000-000000000000", userA)).rejects.toThrow(/not found/i);
      const done = await addIncident(await addMonitor("Web", { status: "up" }), 30, { resolved: true });
      await expect(monitorsService.acknowledgeIncident(done, userA)).rejects.toThrow(/already ended/i);
    });
  });

  describe("status page", () => {
    it("lists only enabled monitors an admin chose, under their plain name, without addresses", async () => {
      await addMonitor("Hidden", { status: "down", show: false });
      await addMonitor("Disabled", { status: "down", show: true, enabled: false });
      await addMonitor("Firewall WAN ping", { status: "up", show: true, statusName: "Internet" });
      const page = await status.page();
      expect(page.items.map((i) => i.name)).toEqual(["Internet"]);
      expect(page.overall).toBe("ok");
      const text = JSON.stringify(page);
      expect(text).not.toContain("10.9.9.9");
      expect(text).not.toContain("connection refused");
    });

    it("shows down first with since and whether somebody is on it", async () => {
      const web = await addMonitor("Website", { status: "down", show: true });
      await addMonitor("Printing", { status: "up", show: true });
      await addMonitor("Wi-Fi", { status: "up", show: true, flapping: true });
      await addIncident(web, 12);
      let page = await status.page();
      expect(page.items.map((i) => [i.name, i.state])).toEqual([
        ["Website", "down"],
        ["Wi-Fi", "flapping"],
        ["Printing", "up"],
      ]);
      expect(page.items[0]!.since).toBeTruthy();
      expect(page.items[0]!.acknowledged).toBe(false);
      expect(page.overall).toBe("degraded");
      await q(`UPDATE monitor_incidents SET acknowledged_at = now() WHERE monitor_id = $1`, [web]);
      page = await status.page();
      expect(page.items[0]!.acknowledged).toBe(true);
    });

    it("carries the maintenance window and the notice", async () => {
      values = { [MAINTENANCE_MODE_KEY]: true, [ALERT_KEYS.statusNotice]: "  Wi-Fi work on Saturday  " };
      await addMonitor("Website", { status: "up", show: true });
      const page = await status.page();
      expect(page.maintenance.enabled).toBe(true);
      expect(page.notice).toBe("Wi-Fi work on Saturday");
    });

    it("says unknown when nothing is listed", async () => {
      const page = await status.page();
      expect(page.items).toEqual([]);
      expect(page.overall).toBe("unknown");
    });
  });
});
