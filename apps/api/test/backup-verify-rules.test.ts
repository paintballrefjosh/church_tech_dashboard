import { describe, expect, it } from "vitest";
import { VERIFY_RECHECK_DAYS, VERIFY_RETRY_MINUTES, VERIFY_RECENT, backupsToVerify, type VerifyCandidate } from "@church/shared";

const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

let n = 0;
function backup(over: Partial<VerifyCandidate> = {}): VerifyCandidate {
  n++;
  const createdAt = over.createdAt ?? NOW - n * DAY;
  return { id: `b${n}`, status: "ready", createdAt, finishedAt: createdAt + MIN, verifiedAt: null, verifyError: null, verifyTriedAt: null, ...over };
}

describe("which backups are due for a check", () => {
  it("picks ready ones that never passed, oldest first, and only the newest few", () => {
    n = 0;
    const rows = Array.from({ length: VERIFY_RECENT + 2 }, () => backup());
    const due = backupsToVerify(rows, NOW);
    expect(due).toHaveLength(VERIFY_RECENT);
    expect(due).toEqual(rows.slice(0, VERIFY_RECENT).map((r) => r.id).reverse());
  });

  it("ignores backups that are running or failed, and ones made a moment ago", () => {
    n = 0;
    const rows = [
      backup({ status: "running", finishedAt: null }),
      backup({ status: "failed" }),
      backup({ createdAt: NOW - MIN, finishedAt: NOW - 30_000 }),
    ];
    expect(backupsToVerify(rows, NOW)).toEqual([]);
    expect(backupsToVerify(rows, NOW + 10 * MIN)).toEqual([rows[2]!.id]);
  });

  it("leaves a passed backup alone, but checks the newest again after a week", () => {
    n = 0;
    const newest = backup({ verifiedAt: NOW - 2 * DAY });
    const older = backup({ verifiedAt: NOW - 30 * DAY });
    expect(backupsToVerify([newest, older], NOW)).toEqual([]);
    expect(backupsToVerify([newest, older], NOW + VERIFY_RECHECK_DAYS * DAY)).toEqual([newest.id]);
  });

  it("retries a failed check only after the wait", () => {
    n = 0;
    const failed = backup({ verifyError: "damaged", verifyTriedAt: NOW - 10 * MIN });
    expect(backupsToVerify([failed], NOW)).toEqual([]);
    expect(backupsToVerify([failed], NOW + VERIFY_RETRY_MINUTES * MIN)).toEqual([failed.id]);
  });
});
