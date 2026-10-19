/**
 * Checking stored backups (admin > Backups): the pure rules, shared by the API and the pages.
 * A check re-reads a backup's archive end to end and proves it is whole and that a restore could use it. It
 * writes nothing to the live data; the real restore rehearsal is `tests/cluster/verify-restore.sh`.
 */

/** The newest this many ready backups are checked once each (older ones were checked when they were new). */
export const VERIFY_RECENT = 3;

/** The newest ready backup is checked again after this long: storage can damage a file that was fine. */
export const VERIFY_RECHECK_DAYS = 7;

/** A check that failed is tried again after this long, so a store that is down for a while is not hammered. */
export const VERIFY_RETRY_MINUTES = 360;

/** A backup is left alone for a few minutes after it is made (the offsite copy and the first look use the same file). */
export const VERIFY_SETTLE_MINUTES = 5;

/** Most problems listed in one report; the rest are counted. */
export const VERIFY_MAX_PROBLEMS = 20;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export interface VerifyCandidate {
  id: string;
  status: string;
  createdAt: number;
  finishedAt: number | null;
  verifiedAt: number | null;
  verifyError: string | null;
  verifyTriedAt: number | null;
}

/**
 * Which backups are due for a check now, oldest first. Only READY ones count; the newest `VERIFY_RECENT` are
 * considered. One that has never passed is due (a failed one waits `VERIFY_RETRY_MINUTES` since its last try); the
 * newest ready backup is also due again once its last pass is `VERIFY_RECHECK_DAYS` old.
 */
export function backupsToVerify(rows: VerifyCandidate[], now: number): string[] {
  const ready = rows
    .filter((r) => r.status === "ready")
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, VERIFY_RECENT);
  const due: VerifyCandidate[] = [];
  ready.forEach((r, i) => {
    if (r.finishedAt !== null && now - r.finishedAt < VERIFY_SETTLE_MINUTES * MINUTE) return;
    const retryAt = r.verifyTriedAt !== null && r.verifyError ? r.verifyTriedAt + VERIFY_RETRY_MINUTES * MINUTE : 0;
    if (r.verifiedAt === null || r.verifyError) {
      if (now >= retryAt) due.push(r);
    } else if (i === 0 && now - r.verifiedAt >= VERIFY_RECHECK_DAYS * DAY) {
      due.push(r);
    }
  });
  return due.sort((a, b) => a.createdAt - b.createdAt).map((r) => r.id);
}

/** Facts about checks that the Security overview judges. */
export interface VerifyFacts {
  /** When any backup last passed a check (epoch ms), or null. */
  lastPassedAt: number | null;
  /** The newest ready backup failed its last check. */
  newestFailing: boolean;
  /** Ready backups from the last 14 days whose last check failed. */
  failing: number;
}

export interface VerifyFinding {
  severity: "critical" | "warn" | "info" | "ok";
  title: string;
  detail: string;
}

/** What the Security overview says about checks, given when the newest ready backup was made; null when there is nothing to say. */
export function judgeVerification(f: VerifyFacts, newestReadyAt: number | null, now: number): VerifyFinding | null {
  if (newestReadyAt === null) return null;
  if (f.newestFailing) {
    return {
      severity: "critical",
      title: "The newest backup failed its check",
      detail: "It may not be restorable. The Backups page says what is wrong; make a new backup once that is fixed.",
    };
  }
  if (f.failing > 0) {
    return {
      severity: "warn",
      title: "An earlier backup failed its check",
      detail: "The newest one is fine, but a stored file was damaged or unreadable. The Backups page says which.",
    };
  }
  if (f.lastPassedAt === null) {
    // A fresh backup has not had its turn yet.
    if (now - newestReadyAt < DAY) return null;
    return {
      severity: "warn",
      title: "No backup has been checked",
      detail: "Backups are re-read automatically after they are made. None has passed yet; use Check on the Backups page.",
    };
  }
  if (now - f.lastPassedAt > 2 * VERIFY_RECHECK_DAYS * DAY) {
    return {
      severity: "warn",
      title: "Backups have not been checked lately",
      detail: "The last successful check is old. Use Check on the Backups page.",
    };
  }
  return { severity: "ok", title: "Stored backups pass their check", detail: "Each new backup is read back end to end after it is made." };
}
