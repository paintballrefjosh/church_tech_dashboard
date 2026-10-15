import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { PERMISSIONS } from "@church/shared";
import { ActivityService } from "../src/activity/activity.service";
import type { AuthenticatedUser } from "../src/auth/current-user.decorator";
import * as schema from "../src/db/schema";

/**
 * The activity feed must show each person only what they could open themselves. Runs the real SQL against a
 * migrated scratch database (see db-stores.integration.test.ts for the setup). It empties the tables it
 * touches, so never point it at a database you care about.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("activity feed visibility", () => {
  let pool: Pool;
  let svc: ActivityService;
  const ids = {
    owner: "", other: "", staff: "", monitorUser: "",
    ticketOwn: "", ticketOther: "", note: "",
    wikiPublic: "", wikiPrivate: "", wikiGroup: "", group: "",
  };

  const as = (id: string, permissions: string[] = []) => ({ id, permissions }) as unknown as AuthenticatedUser;
  const titles = async (u: AuthenticatedUser) => (await svc.list(u, 100)).map((r) => r.title).sort();

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 5 });
    const db = drizzle(pool, { schema });
    for (const t of ["activity_events", "wiki_page_acl", "wiki_pages", "tickets", "notes", "group_memberships", "groups"]) {
      await pool.query(`DELETE FROM ${t}`);
    }
    await pool.query(`DELETE FROM users WHERE email LIKE 'act-%@test.local'`);
    svc = new ActivityService(db as never);

    const mkUser = async (n: string) =>
      (await pool.query<{ id: string }>(`INSERT INTO users (email, name) VALUES ($1, $1) RETURNING id`, [`act-${n}@test.local`])).rows[0]!.id;
    ids.owner = await mkUser("owner");
    ids.other = await mkUser("other");
    ids.staff = await mkUser("staff");
    ids.monitorUser = await mkUser("mon");

    ids.group = (await pool.query<{ id: string }>(`INSERT INTO groups (name) VALUES ('act-team') RETURNING id`)).rows[0]!.id;
    await pool.query(`INSERT INTO group_memberships (user_id, group_id) VALUES ($1, $2)`, [ids.other, ids.group]);

    const ticket = async (owner: string, title: string) =>
      (await pool.query<{ id: string }>(`INSERT INTO tickets (title, created_by_user_id) VALUES ($1, $2) RETURNING id`, [title, owner])).rows[0]!.id;
    ids.ticketOwn = await ticket(ids.owner, "own ticket");
    ids.ticketOther = await ticket(ids.other, "someone else's ticket");

    const page = async (title: string, visibility: string) =>
      (await pool.query<{ id: string }>(`INSERT INTO wiki_pages (title, owner_user_id, visibility) VALUES ($1, $2, $3) RETURNING id`, [title, ids.staff, visibility])).rows[0]!.id;
    ids.wikiPublic = await page("public page", "public");
    ids.wikiPrivate = await page("private page", "group");
    ids.wikiGroup = await page("group page", "group");
    await pool.query(`INSERT INTO wiki_page_acl (page_id, group_id) VALUES ($1, $2)`, [ids.wikiGroup, ids.group]);

    ids.note = (await pool.query<{ id: string }>(`INSERT INTO notes (owner_user_id, title) VALUES ($1, 'secret note') RETURNING id`, [ids.staff])).rows[0]!.id;

    const ev = (actor: string | null, type: string, resourceId: string | null, title: string) =>
      pool.query(`INSERT INTO activity_events (actor_user_id, action, resource_type, resource_id, title) VALUES ($1, 'x', $2, $3, $4)`, [actor, type, resourceId, title]);
    await ev(ids.owner, "ticket", ids.ticketOwn, "ticket:own");
    await ev(ids.other, "ticket", ids.ticketOther, "ticket:other");
    await ev(ids.staff, "wiki_page", ids.wikiPublic, "wiki:public");
    await ev(ids.staff, "wiki_page", ids.wikiPrivate, "wiki:private");
    await ev(ids.staff, "wiki_page", ids.wikiGroup, "wiki:group");
    await ev(ids.staff, "note", ids.note, "note:secret");
    await ev(null, "infra_target", null, "infra:update");
    await ev(null, "brand_new_kind", null, "unknown:kind");
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("shows a baseline user only their own ticket and the public wiki page", async () => {
    expect(await titles(as(ids.owner))).toEqual(["ticket:own", "wiki:public"]);
  });

  it("shows a group member the wiki page shared with their group, but not other restricted pages", async () => {
    const seen = await titles(as(ids.other));
    expect(seen).toContain("wiki:group");
    expect(seen).toContain("wiki:public");
    expect(seen).toContain("ticket:other");
    expect(seen).not.toContain("wiki:private");
    expect(seen).not.toContain("ticket:own");
  });

  it("never shows a note to anyone but its owner, and never an unknown event kind", async () => {
    for (const u of [as(ids.owner), as(ids.other), as(ids.monitorUser, [PERMISSIONS.MONITORS_READ_ANY, PERMISSIONS.TICKETS_READ_ANY, PERMISSIONS.WIKI_READ_ANY])]) {
      const seen = await titles(u);
      expect(seen).not.toContain("note:secret");
      expect(seen).not.toContain("unknown:kind");
    }
    expect(await titles(as(ids.staff))).toContain("note:secret");
  });

  it("shows everything of a kind to its read-any holders", async () => {
    expect(await titles(as(ids.monitorUser, [PERMISSIONS.TICKETS_READ_ANY]))).toEqual(["ticket:other", "ticket:own", "wiki:public"]);
    expect(await titles(as(ids.monitorUser, [PERMISSIONS.WIKI_READ_ANY]))).toEqual(["wiki:group", "wiki:private", "wiki:public"]);
    expect(await titles(as(ids.monitorUser, [PERMISSIONS.MONITORS_READ_ANY]))).toContain("infra:update");
  });

  it("hides infrastructure events from people without monitoring access", async () => {
    expect(await titles(as(ids.owner))).not.toContain("infra:update");
  });
});
