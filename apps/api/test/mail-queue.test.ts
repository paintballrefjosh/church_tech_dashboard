import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIL_ATTEMPTS, MAIL_BACKOFF_SEC, MailQueue } from "../src/mailer/mail-queue";
import type { ClaimedMail, MailOutboxStore } from "../src/mailer/mail-outbox.store";
import type { MailMessage, MailerService } from "../src/mailer/mailer.service";
import type { ClusterJobs } from "../src/cluster/cluster-jobs.service";

interface Row {
  id: string;
  message: MailMessage;
  status: "pending" | "failed";
  attempts: number;
  nextAttemptAt: number;
  claimedUntil: number | null;
  lastError: string | null;
}

/** In-memory outbox with the same rules as the SQL: claim counts an attempt and is exclusive. */
class MemoryOutbox implements MailOutboxStore {
  rows: Row[] = [];
  failAdd = false;
  private n = 0;
  async add(message: MailMessage) {
    if (this.failAdd) throw new Error("db down");
    this.rows.push({ id: `m${++this.n}`, message, status: "pending", attempts: 0, nextAttemptAt: Date.now(), claimedUntil: null, lastError: null });
  }
  async claim(limit: number, claimSec: number): Promise<ClaimedMail[]> {
    const now = Date.now();
    const due = this.rows
      .filter((r) => r.status === "pending" && r.nextAttemptAt <= now && (r.claimedUntil === null || r.claimedUntil < now))
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)
      .slice(0, limit);
    for (const r of due) {
      r.claimedUntil = now + claimSec * 1000;
      r.attempts++;
    }
    return due.map((r) => ({ id: r.id, message: r.message, attempts: r.attempts }));
  }
  async sent(id: string) {
    this.rows = this.rows.filter((r) => r.id !== id);
  }
  async retryLater(id: string, delaySec: number, error: string) {
    const r = this.rows.find((x) => x.id === id)!;
    r.claimedUntil = null;
    r.nextAttemptAt = Date.now() + delaySec * 1000;
    r.lastError = error;
  }
  async giveUp(id: string, error: string) {
    const r = this.rows.find((x) => x.id === id)!;
    r.status = "failed";
    r.claimedUntil = null;
    r.lastError = error;
  }
  async prune() {
    this.rows = this.rows.filter((r) => r.status !== "failed");
  }
}

function makeQueue(store: MailOutboxStore, sendNow: (m: MailMessage) => Promise<void>) {
  const mailer = { setQueue: vi.fn(), sendNow: vi.fn(sendNow) } as unknown as MailerService & { sendNow: ReturnType<typeof vi.fn> };
  const jobs = { register: vi.fn() } as unknown as ClusterJobs;
  const q = new MailQueue(mailer, store, jobs);
  q.onModuleInit();
  return { q, mailer };
}

const msg = (to: string): MailMessage => ({ to, subject: "s", text: "t" });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("MailQueue", () => {
  it("sends a queued message at once and removes it", async () => {
    const store = new MemoryOutbox();
    const { q, mailer } = makeQueue(store, async () => undefined);
    await q.enqueue(msg("a@x"));
    await vi.advanceTimersByTimeAsync(10);
    expect(mailer.sendNow).toHaveBeenCalledTimes(1);
    expect(store.rows).toHaveLength(0);
    await q.onModuleDestroy();
  });

  it("retries a failing message with exponential backoff, then gives up after the last attempt", async () => {
    const store = new MemoryOutbox();
    const times: number[] = [];
    const { q } = makeQueue(store, async () => {
      times.push(Date.now());
      throw new Error("smtp down");
    });
    await q.enqueue(msg("a@x"));
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(times).toHaveLength(MAIL_ATTEMPTS);
    const gaps = times.slice(1).map((t, i) => Math.round((t - times[i]!) / 1000));
    // Backoff 5s, 10s, 20s, 40s; the poll that picks a retry up can add up to 2s.
    gaps.forEach((g, i) => {
      const want = MAIL_BACKOFF_SEC * 2 ** i;
      expect(g).toBeGreaterThanOrEqual(want);
      expect(g).toBeLessThanOrEqual(want + 2);
    });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]!.status).toBe("failed");
    expect(store.rows[0]!.lastError).toBe("smtp down");
    await q.onModuleDestroy();
  });

  it("delivers a message that fails once and then succeeds", async () => {
    const store = new MemoryOutbox();
    let calls = 0;
    const { q } = makeQueue(store, async () => {
      if (++calls === 1) throw new Error("blip");
    });
    await q.enqueue(msg("a@x"));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toBe(2);
    expect(store.rows).toHaveLength(0);
    await q.onModuleDestroy();
  });

  it("sends each message once when several nodes share the outbox", async () => {
    const store = new MemoryOutbox();
    const sent: string[] = [];
    const send = async (m: MailMessage) => {
      sent.push(m.to);
      await new Promise((r) => setTimeout(r, 50));
    };
    const one = makeQueue(store, send);
    const two = makeQueue(store, send);
    const three = makeQueue(store, send);
    for (let i = 0; i < 12; i++) await store.add(msg(`u${i}@x`));
    one.q.kick();
    two.q.kick();
    three.q.kick();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sent.sort()).toEqual(Array.from({ length: 12 }, (_, i) => `u${i}@x`).sort());
    expect(store.rows).toHaveLength(0);
    for (const n of [one, two, three]) await n.q.onModuleDestroy();
  });

  it("sends a message another node claimed and never finished, once its claim lapses", async () => {
    const store = new MemoryOutbox();
    await store.add(msg("orphan@x"));
    await store.claim(5, 120); // a node claimed it, then died
    const { q, mailer } = makeQueue(store, async () => undefined);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(mailer.sendNow).not.toHaveBeenCalled(); // still claimed
    await vi.advanceTimersByTimeAsync(70_000);
    expect(mailer.sendNow).toHaveBeenCalledTimes(1);
    expect(store.rows).toHaveLength(0);
    await q.onModuleDestroy();
  });

  it("falls back to sending inline when the database will not take the message", async () => {
    const store = new MemoryOutbox();
    store.failAdd = true;
    const { q, mailer } = makeQueue(store, async () => undefined);
    await q.enqueue(msg("a@x"));
    expect(mailer.sendNow).toHaveBeenCalledTimes(1);
    await q.onModuleDestroy();
  });

  it("registers itself as the mailer's queue and a prune job", () => {
    const store = new MemoryOutbox();
    const mailer = { setQueue: vi.fn(), sendNow: vi.fn() } as unknown as MailerService;
    const jobs = { register: vi.fn() };
    const q = new MailQueue(mailer, store, jobs as unknown as ClusterJobs);
    q.onModuleInit();
    expect((mailer as unknown as { setQueue: ReturnType<typeof vi.fn> }).setQueue).toHaveBeenCalledWith(q);
    expect(jobs.register).toHaveBeenCalledWith(expect.objectContaining({ name: "mail-outbox-prune" }));
    void q.onModuleDestroy();
  });
});
