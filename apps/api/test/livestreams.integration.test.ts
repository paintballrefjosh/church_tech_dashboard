import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { LivestreamSample } from "@church/shared";
import * as schema from "../src/db/schema";

/**
 * Livestream checks against a real database (docs/livestreams.md): a stream is read by one check at a time, a problem is
 * reported only when two samples agree and only once however many nodes see it, its end is reported, outside its hours it
 * closes silently, and old history is pruned. The network side (yt-dlp, ffmpeg) is replaced by what the test says it
 * found. Run on CockroachDB and YugabyteDB; it empties the livestream tables.
 */
const reading = vi.hoisted(() => ({
  status: { live: true as boolean | null, error: null as string | null },
  sample: null as unknown,
  sampleCalls: 0,
}));

vi.mock("../src/livestreams/livestream-reader", async (orig) => {
  const real = await orig<typeof import("../src/livestreams/livestream-reader")>();
  const status = () => ({
    live: reading.status.live,
    viewers: reading.status.live ? 12 : null,
    title: null,
    startedAt: null,
    source: "link" as const,
    picked: reading.status.live ? { videoUrl: "https://cdn.example/x.m3u8", audioUrl: null, headers: null, bitrate: null } : null,
    error: reading.status.error,
    videoId: null,
  });
  return {
    ...real,
    readLink: async () => status(),
    readPage: async () => status(),
    sampleStream: async () => {
      reading.sampleCalls++;
      // Long enough that a second check started at the same time is still trying while this one reads.
      await new Promise((r) => setTimeout(r, 400));
      return { sample: reading.sample, jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), error: null };
    },
  };
});

const { LivestreamChecker } = await import("../src/livestreams/livestream-checker");
const { LivestreamsService } = await import("../src/livestreams/livestreams.service");

const url = process.env.TEST_DATABASE_URL;

const sample = (over: Partial<LivestreamSample> = {}): LivestreamSample => ({
  sampledAt: new Date().toISOString(),
  seconds: 10,
  video: { codec: "h264", width: 854, height: 480, fps: 30 },
  audio: { codec: "aac", sampleRate: 48000, channels: "stereo" },
  loudnessLufs: -16,
  peakDb: -2,
  channelRmsDb: [-20, -20],
  silentSec: 0,
  frozenSec: 0,
  blackSec: 0,
  bitrate: null,
  ...over,
});
const silent = () => sample({ loudnessLufs: -70, peakDb: -120, channelRmsDb: [-120, -120], silentSec: 10 });

describe.skipIf(!url)("livestream checks against a real database", () => {
  let pool: Pool;
  const sent: Array<{ recipientUserId: string; kind: string; title: string }> = [];
  const q = (text: string, params: unknown[] = []) => pool.query(text, params);
  let groupId: string;
  let memberId: string;
  let make: () => InstanceType<typeof LivestreamChecker>;
  let streams: InstanceType<typeof LivestreamsService>;

  beforeAll(async () => {
    process.env.AUTH_SECRET ??= "test-secret-for-livestreams-integration";
    pool = new Pool({ connectionString: url, max: 6 });
    const db = drizzle(pool, { schema });
    for (const t of ["livestream_checks", "livestream_snapshots", "livestreams"]) await q(`DELETE FROM ${t}`);
    await q(`DELETE FROM users WHERE email = 'ls-member@test.local'`);
    await q(`DELETE FROM groups WHERE name = 'ls-test-group'`);
    memberId = (await q(`INSERT INTO users (email, name) VALUES ('ls-member@test.local', 'Member') RETURNING id`)).rows[0].id;
    groupId = (await q(`INSERT INTO groups (name, description) VALUES ('ls-test-group', '') RETURNING id`)).rows[0].id;
    await q(`INSERT INTO group_memberships (group_id, user_id) VALUES ($1, $2)`, [groupId, memberId]);
    const settings = { get: async () => undefined };
    streams = new LivestreamsService(db as never, settings as never);
    const jobs = { register: () => undefined };
    const notifications = { createMany: async (rows: typeof sent) => void sent.push(...rows) };
    const delivery = { zone: async () => "UTC" };
    const infra = { monitoringRecipientIds: async () => [] };
    make = () => new LivestreamChecker(db as never, jobs as never, streams, settings as never, notifications as never, delivery as never, infra as never);
  });
  afterAll(async () => {
    await pool?.end();
  });
  beforeEach(() => {
    sent.length = 0;
    reading.status = { live: true, error: null };
    reading.sample = sample();
    reading.sampleCalls = 0;
  });

  async function newStream(schedule = "") {
    const s = await streams.create(
      { name: "Sunday", platform: "other", access: "public", pageUrl: "https://cdn.example/x.m3u8", platformRef: "", statusIntervalSec: 60, sampleIntervalSec: 300, sampleSeconds: 10, schedule, graceMin: 5, silenceDb: -50, checkVideo: true, alertGroupId: groupId, encoderMonitorId: null, enabled: true, streamUrl: null },
      null,
    );
    return s.id;
  }

  it("reads a stream once at a time across nodes", async () => {
    const id = await newStream();
    const [a, b] = await Promise.all([make().checkNow(id), make().checkNow(id)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(reading.sampleCalls).toBe(1);
    const s = await streams.get(id);
    expect(s).toMatchObject({ state: "live", live: true, viewers: 12, problems: [], hasSnapshot: true });
    expect(Number((await q(`SELECT count(*) AS n FROM livestreams WHERE id = $1 AND claimed_until IS NULL`, [id])).rows[0].n)).toBe(1);
  });

  it("reports a silence only when two samples agree, once across nodes, and reports its end", async () => {
    const id = await newStream();
    reading.sample = silent();
    await make().checkNow(id);
    let s = await streams.get(id);
    expect(s.problems).toEqual([]);
    expect(s.sampleProblems).toEqual(["silent"]);
    // Looked at again soon, not in five minutes.
    expect(new Date(s.nextSampleAt!).getTime() - Date.now()).toBeLessThan(31_000);
    expect(sent).toHaveLength(0);

    // Two nodes see the second silent sample from the same row: one notice.
    const row = await streams.row(id);
    await Promise.all([make().check(row, true), make().check(row, true)]);
    s = await streams.get(id);
    expect(s.state).toBe("problem");
    expect(s.problems).toEqual(["silent"]);
    expect(sent.map((n) => [n.recipientUserId, n.kind])).toEqual([[memberId, "livestream.problem"]]);
    expect(sent[0]!.title).toContain("no sound");

    sent.length = 0;
    reading.sample = sample();
    await make().checkNow(id);
    expect((await streams.get(id)).state).toBe("live");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.title).toContain("is back");
    const kinds = (await streams.history(id, 1)).map((h) => h.kind);
    expect(kinds.filter((k) => k === "sample")).toHaveLength(4);
  });

  it("outside its hours nothing is read, and an open problem closes without a notice", async () => {
    // A window that is never now: an hour that has just passed, on today's weekday.
    const past = new Date(Date.now() - 3 * 3_600_000);
    const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][past.getUTCDay()];
    const hh = String(past.getUTCHours()).padStart(2, "0");
    const id = await newStream(`${day} ${hh}:00-${hh}:30`);
    await q(`UPDATE livestreams SET alerted_problem = 'not_live', problems = '["not_live"]'::jsonb WHERE id = $1`, [id]);
    const row = await streams.row(id);
    await make().check(row, false);
    const s = await streams.get(id);
    expect(s).toMatchObject({ state: "outside_hours", problems: [] });
    expect(reading.sampleCalls).toBe(0);
    expect(sent).toHaveLength(0);
    expect((await q(`SELECT alerted_problem FROM livestreams WHERE id = $1`, [id])).rows[0].alerted_problem).toBe("");
  });

  it("an edit that changes what is read starts afresh, and the picture goes", async () => {
    const id = await newStream();
    await make().checkNow(id);
    expect((await streams.get(id)).hasSnapshot).toBe(true);
    const s = await streams.update(id, { pageUrl: "https://cdn.example/other.m3u8" });
    expect(s).toMatchObject({ state: "unknown", live: null, hasSnapshot: false, sample: null });
    const renamed = await streams.update(id, { name: "Renamed" });
    expect(renamed.state).toBe("unknown");
  });

  it("keeps a private link encrypted and never returns it", async () => {
    const id = await newStream();
    const s = await streams.update(id, { access: "private", streamUrl: "https://cdn.example/secret.m3u8?token=abc" });
    expect(s.hasStreamUrl).toBe(true);
    expect(JSON.stringify(s)).not.toContain("token=abc");
    const stored = (await q(`SELECT stream_url_enc FROM livestreams WHERE id = $1`, [id])).rows[0].stream_url_enc as string;
    expect(stored.startsWith("enc:v1:")).toBe(true);
    expect((await streams.update(id, { streamUrl: "[saved]" })).hasStreamUrl).toBe(true);
    expect((await streams.update(id, { streamUrl: null })).hasStreamUrl).toBe(false);
  });

  it("prunes history older than 30 days", async () => {
    const id = await newStream();
    await q(`INSERT INTO livestream_checks (livestream_id, ts, kind) VALUES ($1, now() - INTERVAL '40 days', 'status'), ($1, now() - INTERVAL '1 day', 'status')`, [id]);
    expect(await make().prune()).toBe(1);
    expect(Number((await q(`SELECT count(*) AS n FROM livestream_checks WHERE livestream_id = $1`, [id])).rows[0].n)).toBe(1);
  });
});
