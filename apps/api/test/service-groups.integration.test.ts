import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../src/db/schema";
import { ServiceMonitoringService } from "../src/service-monitoring/service-monitoring.service";
import { ServiceGroupsService } from "../src/service-monitoring/service-groups.service";
import { StatusService } from "../src/monitors/status.service";
import { DefaultAvailabilitySources } from "../src/availability/availability.sources";

/**
 * Service groups against a real database (docs/service-monitoring.md): a group of keepalived services on two hosts opens ONE
 * incident (with `service_group_id`) when nobody is MASTER for its time, two nodes judging at once still open one and tell
 * people once, the end resolves it, alerts off tells nobody, and deleting the group takes its incidents and leaves the
 * services. Members' readings are written straight into `service_instances` (the poller is tested elsewhere). Part two: a role
 * read differently per template, the redundancy warning on its own clock, the status page and the availability history.
 * Run on CockroachDB and YugabyteDB; it empties the service tables.
 */

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("service groups against a real database", () => {
  let pool: Pool;
  const q = (text: string, params: unknown[] = []) => pool.query(text, params);
  const sent: Array<{ kind: string; title: string; link: string }> = [];
  let make: () => ServiceGroupsService;
  let groups: ServiceGroupsService;
  let userId: string;
  let a: string;
  let b: string;
  let c: string;
  let status: StatusService;
  const settings: Record<string, unknown> = {};

  beforeAll(async () => {
    process.env.AUTH_SECRET ??= "test-secret-for-service-groups-integration";
    pool = new Pool({ connectionString: url, max: 6 });
    const db = drizzle(pool, { schema });
    await q(`DELETE FROM monitor_incidents WHERE service_group_id IS NOT NULL`);
    for (const t of ["service_instances", "service_groups"]) await q(`DELETE FROM ${t}`);
    await q(`DELETE FROM infra_targets WHERE name LIKE 'grp-test-%'`);
    await q(`DELETE FROM users WHERE email = 'grp-test@test.local'`);
    userId = (await q(`INSERT INTO users (email, name) VALUES ('grp-test@test.local', 'Grp') RETURNING id`)).rows[0].id;
    const h1 = (await q(`INSERT INTO infra_targets (name, kind, host) VALUES ('grp-test-lb1', 'linux_ssh', '192.0.2.1') RETURNING id`)).rows[0].id;
    const h2 = (await q(`INSERT INTO infra_targets (name, kind, host) VALUES ('grp-test-lb2', 'linux_ssh', '192.0.2.2') RETURNING id`)).rows[0].id;
    const ins = async (host: string, name: string) =>
      (await q(`INSERT INTO service_instances (target_id, template_key, name, inputs) VALUES ($1, 'keepalived', $2, '{}'::jsonb) RETURNING id`, [host, name])).rows[0]
        .id as string;
    a = await ins(h1, "keepalived");
    b = await ins(h2, "keepalived");
    c = (await q(`INSERT INTO service_instances (target_id, template_key, name, inputs) VALUES ($1, 'mysql', 'mariadb', '{}'::jsonb) RETURNING id`, [h1])).rows[0].id;

    const infra = { getCredential: async () => null, monitoringRecipientIds: async () => [userId] };
    const services = new ServiceMonitoringService(db as never, infra as never);
    const jobs = { register: () => undefined };
    const notifications = { createMany: async (rows: typeof sent) => void sent.push(...rows) };
    const activity = { record: async () => undefined };
    const settingsSvc = { get: async (k: string) => settings[k] };
    make = () => new ServiceGroupsService(db as never, jobs as never, services, infra as never, notifications as never, activity as never, settingsSvc as never);
    groups = make();
    status = new StatusService(db as never, { get: async () => undefined } as never);
  });

  afterAll(async () => {
    await q(`DELETE FROM service_groups`).catch(() => undefined);
    await q(`DELETE FROM infra_targets WHERE name LIKE 'grp-test-%'`).catch(() => undefined);
    await q(`DELETE FROM users WHERE email = 'grp-test@test.local'`).catch(() => undefined);
    await pool?.end();
  });

  beforeEach(async () => {
    sent.length = 0;
    await q(`DELETE FROM service_groups`);
    await q(`DELETE FROM availability_hourly WHERE kind = 'service_group'`);
  });

  /** As the poller would leave them: up, read just now, holding these roles. */
  const read = async (roles: [string, string]) => {
    await q(`UPDATE service_instances SET status = 'up', last_polled_at = now(), last_states = jsonb_build_object('role', $2::text) WHERE id = $1`, [a, roles[0]]);
    await q(`UPDATE service_instances SET status = 'up', last_polled_at = now(), last_states = jsonb_build_object('role', $2::text) WHERE id = $1`, [b, roles[1]]);
  };
  const base = { description: "", minHealthy: null, role: null, forSec: 0, alerts: true, redundancyAfterMin: null, showOnStatus: false, statusName: null };
  const pair = (over: Partial<{ alerts: boolean; forSec: number; minHealthy: number | null; redundancyAfterMin: number | null; showOnStatus: boolean; statusName: string | null }> = {}) =>
    groups.create({ ...base, name: "Load balancer pair", minHealthy: 1, role: { metric: "role", value: "MASTER", min: 1, max: 1 }, instanceIds: [a, b], ...over }, userId);
  const openIncidents = async (groupId: string) =>
    (await q(`SELECT rule_id, reason, target_id, monitor_id FROM monitor_incidents WHERE service_group_id = $1 AND resolved_at IS NULL`, [groupId])).rows;

  it("a healthy pair is up and opens nothing", async () => {
    await read(["MASTER", "BACKUP"]);
    const g = await pair();
    expect(g).toMatchObject({ status: "up", counted: 2, working: 2, roleCount: 1 });
    expect(g.members.map((m) => m.role).sort()).toEqual(["BACKUP", "MASTER"]);
    await groups.evaluateAll();
    expect(await openIncidents(g.id)).toEqual([]);
    expect((await q(`SELECT status FROM service_groups WHERE id = $1`, [g.id])).rows[0].status).toBe("up");
    // The members carry the group's name.
    const listed = await new ServiceMonitoringService(drizzle(pool, { schema }) as never, {} as never).get(a);
    expect(listed).toMatchObject({ groupId: g.id, groupName: "Load balancer pair" });
  });

  it("split brain opens one incident even with two nodes judging at once, and its end resolves it", async () => {
    await read(["MASTER", "MASTER"]);
    const g = await pair();
    await Promise.all([make().evaluateAll(), make().evaluateAll()]);
    const open = await openIncidents(g.id);
    expect(open).toEqual([{ rule_id: "group:role", reason: "Load balancer pair: 2 members are MASTER (exactly 1 wanted)", target_id: null, monitor_id: null }]);
    expect(sent.filter((s) => s.kind === "infra.alert.opened")).toHaveLength(1);
    expect(sent[0]!.link).toBe(`/monitoring/infra/service-groups/${g.id}`);
    expect((await groups.get(g.id)).checks.find((c) => c.id === "role")).toMatchObject({ breaching: true, open: true });

    // Another run while it lasts: nothing new.
    await groups.evaluateAll();
    expect(sent).toHaveLength(1);

    await read(["MASTER", "BACKUP"]);
    await groups.evaluateAll();
    expect(await openIncidents(g.id)).toEqual([]);
    expect(sent.map((s) => s.kind)).toEqual(["infra.alert.opened", "infra.alert.resolved"]);
  });

  it("waits forSec before opening", async () => {
    await read(["BACKUP", "BACKUP"]);
    const g = await pair({ forSec: 120 });
    await groups.evaluateAll(new Date());
    expect(await openIncidents(g.id)).toEqual([]);
    await groups.evaluateAll(new Date(Date.now() + 121_000));
    expect((await openIncidents(g.id)).map((r) => r.rule_id)).toEqual(["group:role"]);
  });

  it("too few working is the quorum rule, and a stale reading does not count", async () => {
    await read(["MASTER", "BACKUP"]);
    await q(`UPDATE service_instances SET status = 'down' WHERE id = $1`, [a]);
    await q(`UPDATE service_instances SET last_polled_at = now() - interval '1 hour' WHERE id = $1`, [b]);
    const g = await pair();
    await groups.evaluateAll();
    expect((await openIncidents(g.id)).map((r) => r.rule_id)).toEqual(["group:quorum"]);
    expect((await groups.get(g.id)).members.find((m) => m.id === b)).toMatchObject({ working: false, stale: true });
  });

  it("alerts off and maintenance mode record the incident but tell nobody", async () => {
    await read(["BACKUP", "BACKUP"]);
    const quiet = await pair({ alerts: false });
    await groups.evaluateAll();
    expect(await openIncidents(quiet.id)).toHaveLength(1);
    expect(sent).toEqual([]);

    await q(`DELETE FROM service_groups`);
    settings["monitoring.maintenance_mode"] = true;
    try {
      const g = await pair();
      await groups.evaluateAll();
      expect(await openIncidents(g.id)).toHaveLength(1);
      expect(sent).toEqual([]);
    } finally {
      delete settings["monitoring.maintenance_mode"];
    }
  });

  it("refuses a role the members cannot report, a quorum above the member count and a second group with the same name", async () => {
    await read(["MASTER", "BACKUP"]);
    await expect(
      groups.create({ ...base, name: "x", role: { metric: "nope", value: "MASTER", min: 1, max: 1 }, instanceIds: [a, b] }, userId),
    ).rejects.toThrow(/"nope" is not a state the .* template reports/);
    await expect(groups.create({ ...base, name: "x", minHealthy: 3, instanceIds: [a, b] }, userId)).rejects.toThrow(/more than the 2/);
    await pair();
    await expect(pair()).rejects.toThrow(/already exists/);
  });

  it("a service moves between groups, and deleting a group takes its incidents and leaves its services", async () => {
    await read(["BACKUP", "BACKUP"]);
    const g = await pair();
    const other = await groups.create({ ...base, name: "Other", instanceIds: [b] }, userId);
    expect((await groups.get(g.id)).members.map((m) => m.id)).toEqual([a]);
    expect((await groups.get(other.id)).members.map((m) => m.id)).toEqual([b]);

    await groups.update(g.id, { ...base, name: "Load balancer pair", instanceIds: [a] });
    await q(`UPDATE service_instances SET status = 'down' WHERE id = $1`, [a]);
    await groups.evaluateAll();
    expect(await openIncidents(g.id)).toHaveLength(1);
    await groups.remove(g.id);
    expect(Number((await q(`SELECT count(*) AS n FROM monitor_incidents WHERE service_group_id = $1`, [g.id])).rows[0].n)).toBe(0);
    expect((await q(`SELECT group_id FROM service_instances WHERE id = $1`, [a])).rows[0].group_id).toBeNull();
  });

  it("a role read differently per template: refused where a template cannot report it, counted by each one's own words", async () => {
    await read(["MASTER", "BACKUP"]);
    await q(`UPDATE service_instances SET status = 'up', last_polled_at = now(), last_states = jsonb_build_object('galera_state', 'Synced') WHERE id = $1`, [c]);
    const choices = await groups.roleChoices([a, c]);
    expect(choices.common).toEqual([]);
    expect(choices.templates.map((t) => t.key).sort()).toEqual(["keepalived", "mysql"]);
    // Without saying how MariaDB (template "mysql") reports it, "role" is refused for that template.
    await expect(
      groups.create({ ...base, name: "Mixed", role: { metric: "role", value: "MASTER", min: 1, max: 1 }, instanceIds: [a, c] }, userId),
    ).rejects.toThrow(/"role" is not a state the .* template reports/);
    const role = { metric: "role", value: "holder", min: 1, max: 1, byTemplate: { keepalived: { metric: "role", value: "MASTER" }, mysql: { metric: "galera_state", value: "Synced" } } };
    const g = await groups.create({ ...base, name: "Mixed", role, instanceIds: [a, c] }, userId);
    // Both hold "the role" in their own words: two where one is wanted.
    expect(g.roleCount).toBe(2);
    expect(g.members.map((m) => m.role).sort()).toEqual(["MASTER", "Synced"]);
    await groups.evaluateAll();
    expect((await openIncidents(g.id)).map((r) => r.reason)).toEqual(["Mixed: 2 members are holder (exactly 1 wanted)"]);
    await q(`UPDATE service_instances SET last_states = jsonb_build_object('galera_state', 'Donor') WHERE id = $1`, [c]);
    await groups.evaluateAll();
    expect(await openIncidents(g.id)).toEqual([]);
  });

  it("the redundancy warning waits its own minutes, and does not make the group down on the status page", async () => {
    await read(["MASTER", "BACKUP"]);
    await q(`UPDATE service_instances SET status = 'down' WHERE id = $1`, [b]);
    const g = await pair({ redundancyAfterMin: 5, showOnStatus: true, statusName: "Front door" });
    const t0 = new Date();
    // Judged at a later time, as if the poller had kept reading the members until then.
    const at = async (ms: number) => {
      const when = new Date(t0.getTime() + ms);
      await q(`UPDATE service_instances SET last_polled_at = $1 WHERE id IN ($2, $3)`, [when.toISOString(), a, b]);
      await groups.evaluateAll(when);
    };
    await at(0);
    await at(240_000);
    expect(await openIncidents(g.id)).toEqual([]);
    await at(301_000);
    expect((await openIncidents(g.id)).map((r) => r.rule_id)).toEqual(["group:redundancy"]);
    expect(sent.map((x) => x.kind)).toEqual(["infra.alert.opened"]);
    const item = (await status.page()).items.find((i) => i.id === g.id);
    expect(item).toEqual({ id: g.id, name: "Front door", state: "up", since: null, acknowledged: false });

    await read(["MASTER", "BACKUP"]);
    await at(330_000);
    expect(await openIncidents(g.id)).toEqual([]);
    expect(sent.map((x) => x.kind)).toEqual(["infra.alert.opened", "infra.alert.resolved"]);
  });

  it("the status page lists only groups chosen for it, by name, down with the open incident's start", async () => {
    await read(["BACKUP", "BACKUP"]);
    const shown = await pair({ showOnStatus: true });
    await groups.create({ ...base, name: "Hidden group", instanceIds: [c] }, userId);
    await groups.evaluateAll();
    const page = await status.page();
    const mine = page.items.filter((i) => [shown.id].includes(i.id) || i.name === "Hidden group");
    const [inc] = await openIncidents(shown.id);
    expect(inc).toBeTruthy();
    const started = (await q(`SELECT extract(epoch FROM started_at) * 1000 AS ms FROM monitor_incidents WHERE service_group_id = $1`, [shown.id])).rows[0].ms;
    expect(mine).toEqual([{ id: shown.id, name: "Load balancer pair", state: "down", since: new Date(Number(started)).toISOString(), acknowledged: false }]);
    // Names only: never a member, a host or the reason.
    expect(JSON.stringify(page)).not.toMatch(/grp-test-lb|keepalived|MASTER/);
  });

  it("samples groups into the availability history and reports the day and the week", async () => {
    await read(["MASTER", "BACKUP"]);
    const g = await pair();
    await groups.evaluateAll();
    const sources = new DefaultAvailabilitySources(drizzle(pool, { schema }) as never, {} as never, {} as never);
    expect((await sources.serviceGroups()).filter((x) => x.ref === g.id)).toEqual([{ kind: "service_group", ref: g.id, label: "Load balancer pair", down: false }]);
    const hour = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
    const old = new Date(hour.getTime() - 3 * 86_400_000);
    await q(`INSERT INTO availability_hourly (kind, ref, hour, label, samples, down) VALUES ('service_group', $1, $2, 'x', 60, 0), ('service_group', $1, $3, 'x', 60, 30)`, [g.id, hour.toISOString(), old.toISOString()]);
    expect((await groups.get(g.id)).availability).toEqual({ day: 100, week: 75 });
  });
});
