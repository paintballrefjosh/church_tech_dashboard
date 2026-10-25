import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { PERMISSIONS } from "@church/shared";
import { AssetsService } from "../src/assets/assets.service";
import { LocationsService } from "../src/assets/locations.service";
import * as schema from "../src/db/schema";

/**
 * Rooms and equipment against a real database (docs/assets.md): the one-open-check-out index, the overdue claim and the
 * cabinets' text turned into rooms. Run on CockroachDB and YugabyteDB. It empties the tables it uses, so never point it at a
 * database you care about.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("rooms and equipment against a real database", () => {
  let pool: Pool;
  let assets: AssetsService;
  let rooms: LocationsService;
  const sent: Array<{ recipientUserId: string; kind: string }> = [];
  const q = (text: string, params: unknown[] = []) => pool.query(text, params);
  let staff: { id: string; name: string; email: string; permissions: string[] };
  let volunteer: { id: string; name: string; email: string; permissions: string[] };

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 5 });
    const db = drizzle(pool, { schema });
    await q(`UPDATE tickets SET asset_id = NULL, location_id = NULL`);
    for (const t of ["asset_checkouts", "assets", "rack_items", "racks", "locations"]) await q(`DELETE FROM ${t}`);
    await q(`DELETE FROM users WHERE email IN ('assets-staff@test.local', 'assets-vol@test.local')`);
    const s = (await q(`INSERT INTO users (email, name) VALUES ('assets-staff@test.local', 'Staff') RETURNING id`)).rows[0].id;
    const v = (await q(`INSERT INTO users (email, name) VALUES ('assets-vol@test.local', 'Vol') RETURNING id`)).rows[0].id;
    staff = { id: s, name: "Staff", email: "assets-staff@test.local", permissions: [PERMISSIONS.ASSETS_READ_ANY, PERMISSIONS.ASSETS_CHECKOUT_OWN, PERMISSIONS.ASSETS_WRITE_ANY] };
    volunteer = { id: v, name: "Vol", email: "assets-vol@test.local", permissions: [PERMISSIONS.ASSETS_READ_ANY, PERMISSIONS.ASSETS_CHECKOUT_OWN] };
    const jobs = { register: () => undefined };
    const search = { assetsChanged: () => undefined };
    rooms = new LocationsService(db as never, jobs as never, search as never);
    const notifications = { createMany: async (rows: Array<{ recipientUserId: string; kind: string }>) => void sent.push(...rows) };
    const delivery = { zone: async () => "UTC" };
    assets = new AssetsService(db as never, jobs as never, rooms, notifications as never, delivery as never, search as never);
  });
  afterAll(async () => {
    await pool?.end();
  });

  it("allows one open check-out per item, even when two arrive at once", async () => {
    const mic = await assets.create({ name: "Mic", category: "audio", make: "", model: "", serial: "", locationId: null, status: "in_service", lendable: true, purchasedOn: null, cost: 10, warrantyUntil: null, notes: "" }, staff as never);
    expect(mic.tag).toMatch(/^A-\d{4,}$/);
    const both = await Promise.allSettled([
      assets.checkout(mic.id, { dueOn: null, note: "" }, staff as never),
      assets.checkout(mic.id, { dueOn: null, note: "" }, volunteer as never),
    ]);
    expect(both.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(Number((await q(`SELECT count(*) AS n FROM asset_checkouts WHERE asset_id = $1 AND returned_at IS NULL`, [mic.id])).rows[0].n)).toBe(1);
    const holder = (await assets.get(mic.id, staff as never)).holder!;
    const who = holder.userId === staff.id ? staff : volunteer;
    await assets.returnAsset(mic.id, { note: "" }, who as never);
    await expect(assets.returnAsset(mic.id, { note: "" }, who as never)).rejects.toThrow(/not checked out/);
    const again = await assets.checkout(mic.id, { dueOn: null, note: "" }, volunteer as never);
    expect(again.holder?.userId).toBe(volunteer.id);
    // A volunteer sees no cost; staff do.
    expect(again.cost).toBeNull();
    expect((await assets.get(mic.id, staff as never)).cost).toBe(10);
    await assets.returnAsset(mic.id, { note: "" }, staff as never);
  });

  it("sends one overdue notice per due date, claimed first, and none for a long-overdue one", async () => {
    sent.length = 0;
    const cam = await assets.create({ name: "Camera", category: "video", make: "", model: "", serial: "", locationId: null, status: "in_service", lendable: true, purchasedOn: null, cost: null, warrantyUntil: null, notes: "" }, staff as never);
    const old = await assets.create({ name: "Old laptop", category: "computer", make: "", model: "", serial: "", locationId: null, status: "in_service", lendable: true, purchasedOn: null, cost: null, warrantyUntil: null, notes: "" }, staff as never);
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    await assets.checkout(cam.id, { holderUserId: volunteer.id, dueOn: day(-2), note: "" }, staff as never);
    await assets.checkout(old.id, { holderUserId: volunteer.id, dueOn: day(-60), note: "" }, staff as never);
    const [a, b] = await Promise.all([assets.remindOverdueOnce(), assets.remindOverdueOnce()]);
    expect(a.sent + b.sent).toBe(1);
    expect(sent.map((s) => s.recipientUserId).sort()).toEqual([staff.id, volunteer.id].sort());
    expect((await assets.remindOverdueOnce()).sent).toBe(0);
    // A new due date starts again.
    await assets.setDue(cam.id, day(-1), staff as never);
    expect((await assets.remindOverdueOnce()).sent).toBe(1);
    const flagged = (await q(`SELECT reminded_for::text AS r FROM asset_checkouts WHERE asset_id = $1`, [old.id])).rows[0].r;
    expect(String(flagged)).toBe(day(-60));
  });

  it("turns cabinets' location text into rooms once, matching by name, and a rename follows", async () => {
    await q(`INSERT INTO racks (name, location, units) VALUES ('R1', 'Server room', 12), ('R2', ' Server room ', 12), ('R3', '', 12)`);
    expect((await rooms.adoptRackLocations()).linked).toBe(2);
    expect((await rooms.adoptRackLocations()).linked).toBe(0);
    const list = await rooms.list();
    expect(list.map((r) => r.name)).toEqual(["Server room"]);
    await rooms.update(list[0]!.id, { name: "Comms room" });
    const texts = (await q(`SELECT location FROM racks WHERE location_id IS NOT NULL ORDER BY name`)).rows.map((r) => r.location);
    expect(texts).toEqual(["Comms room", "Comms room"]);
    await rooms.remove(list[0]!.id);
    const after = (await q(`SELECT count(*) AS n FROM racks WHERE location_id IS NULL AND location = ''`)).rows[0].n;
    expect(Number(after)).toBe(3);
    expect((await rooms.adoptRackLocations()).linked).toBe(0);
  });

  it("imports all or nothing", async () => {
    const before = Number((await q(`SELECT count(*) AS n FROM assets`)).rows[0].n);
    const row = (name: string, tag = "") => ({ name, tag, category: "cable" as const, make: "", model: "", serial: "", status: "in_service" as const, lendable: true, purchasedOn: null, cost: null, warrantyUntil: null, notes: "", room: "Hall" });
    await expect(assets.import({ rows: [row("a")], createRooms: false })).rejects.toThrow(/do not exist/);
    const taken = (await q(`SELECT tag FROM assets LIMIT 1`)).rows[0].tag;
    await expect(assets.import({ rows: [row("b"), row("c", taken)], createRooms: true })).rejects.toThrow(/already has/);
    expect(Number((await q(`SELECT count(*) AS n FROM assets`)).rows[0].n)).toBe(before);
    expect((await rooms.list()).length).toBe(0);
    const ok = await assets.import({ rows: [row("d"), row("e")], createRooms: true });
    expect(ok).toEqual({ created: 2, roomsCreated: ["Hall"] });
  });
});
