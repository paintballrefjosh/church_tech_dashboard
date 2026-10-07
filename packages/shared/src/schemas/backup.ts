import { z } from "zod";

/**
 * Backups of the dashboard's own data (admin > Backups). A backup is one `.tar.gz`
 * holding every table that matters as NDJSON plus, optionally, the uploaded files.
 * Types here are shared by the API (apps/api/src/backup/) and the admin pages.
 */

export const BACKUP_KINDS = ["manual", "scheduled", "pre_restore", "uploaded"] as const;
export type BackupKind = (typeof BACKUP_KINDS)[number];

export const BACKUP_STATUSES = ["running", "ready", "failed"] as const;
export type BackupStatus = (typeof BACKUP_STATUSES)[number];

export const BACKUP_OPERATION_KINDS = ["backup", "import", "compare", "restore"] as const;
export type BackupOperationKind = (typeof BACKUP_OPERATION_KINDS)[number];

export const BACKUP_OPERATION_STATUSES = ["running", "succeeded", "failed"] as const;
export type BackupOperationStatus = (typeof BACKUP_OPERATION_STATUSES)[number];

/** What a person must type to confirm a restore. */
export const RESTORE_CONFIRM_PHRASE = "RESTORE";

export const backupCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    /** Include the uploaded files (wiki attachments, note images). Default true. */
    includeFiles: z.boolean().default(true),
  })
  .strict();
export type BackupCreate = z.infer<typeof backupCreateSchema>;

export const backupRenameSchema = z.object({ name: z.string().trim().min(1).max(120) }).strict();

export const BACKUP_FREQUENCIES = ["daily", "weekly", "monthly"] as const;
export type BackupFrequency = (typeof BACKUP_FREQUENCIES)[number];

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour HH:MM");

/** An IANA zone such as `Europe/London`; checked against the runtime's own list. */
export const timezoneSchema = z.string().min(1).max(64).refine(
  (tz) => {
    try {
      new Intl.DateTimeFormat("en-GB", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { message: "Unknown time zone" },
);

export const backupScheduleInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    enabled: z.boolean().default(true),
    frequency: z.enum(BACKUP_FREQUENCIES),
    /** Local time of day in `timezone`. */
    time: timeOfDay,
    /** 0 = Sunday ... 6 = Saturday. Used by `weekly`. */
    dayOfWeek: z.number().int().min(0).max(6).default(0),
    /** 1-28 (so every month has the day). Used by `monthly`. */
    dayOfMonth: z.number().int().min(1).max(28).default(1),
    timezone: timezoneSchema,
    /** How many of this schedule's backups to keep; older ones are deleted. */
    keep: z.number().int().min(1).max(365).default(7),
    includeFiles: z.boolean().default(true),
  })
  .strict();
export type BackupScheduleInput = z.infer<typeof backupScheduleInputSchema>;

export const backupScheduleUpdateSchema = backupScheduleInputSchema.partial().strict();
export type BackupScheduleUpdate = z.infer<typeof backupScheduleUpdateSchema>;

export interface BackupSchedule {
  id: string;
  name: string;
  enabled: boolean;
  frequency: BackupFrequency;
  time: string;
  dayOfWeek: number;
  dayOfMonth: number;
  timezone: string;
  keep: number;
  includeFiles: boolean;
  lastRunAt: string | null;
  lastStatus: "ok" | "failed" | null;
  lastError: string | null;
  nextRunAt: string | null;
  createdAt: string;
}

export interface BackupSummary {
  id: string;
  name: string;
  kind: BackupKind;
  status: BackupStatus;
  scheduleId: string | null;
  scheduleName: string | null;
  createdAt: string;
  finishedAt: string | null;
  sizeBytes: number | null;
  includeFiles: boolean;
  fileCount: number;
  fileBytes: number;
  /** Rows per table, as stored. */
  tableCounts: Record<string, number>;
  totalRows: number;
  /** How many migrations the database had applied when this was made. */
  schemaMigrations: number | null;
  appVersion: string | null;
  createdBy: { id: string; email: string; displayName: string | null } | null;
  error: string | null;
}

export interface BackupProgress {
  /** What it is doing now, e.g. "Reading tickets". */
  label: string;
  done: number;
  total: number;
}

export interface BackupOperation<R = unknown> {
  id: string;
  kind: BackupOperationKind;
  status: BackupOperationStatus;
  backupId: string | null;
  phase: string;
  progress: BackupProgress | null;
  result: R | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** One changed column of a changed row. Values are shortened; secret columns show only that they differ. */
export interface BackupDiffColumnChange {
  column: string;
  /** The value now. */
  current: string | null;
  /** The value in the backup, which a restore would put back. */
  backup: string | null;
  secret?: boolean;
}

export interface BackupDiffRow {
  /** A human label for the row (a title, an email, ...), or its key. */
  label: string;
  key: string;
}

export interface BackupDiffChangedRow extends BackupDiffRow {
  changes: BackupDiffColumnChange[];
}

export interface BackupDiffTable {
  table: string;
  title: string;
  /** Rows in the backup / right now. */
  backupRows: number;
  currentRows: number;
  /** In the backup, missing now: a restore brings them back. */
  added: number;
  /** Here now, not in the backup: a restore deletes them. */
  removed: number;
  /** In both with different content: a restore puts the backup's content back. */
  changed: number;
  unchanged: number;
  samples: {
    added: BackupDiffRow[];
    removed: BackupDiffRow[];
    changed: BackupDiffChangedRow[];
  };
}

export interface BackupDiffGroup {
  key: string;
  title: string;
  tables: BackupDiffTable[];
}

export interface BackupDiffFiles {
  /** Files in the backup that are missing from storage now. */
  added: number;
  addedBytes: number;
  /** Files in storage now that the backup does not know (deleted after the restore). */
  removed: number;
  removedBytes: number;
  samples: { added: string[]; removed: string[] };
}

export interface BackupCompatibility {
  /** False when a restore cannot go ahead, with `errors` saying why. */
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** A line of the report about rows a partial restore leaves alone, with why. */
export interface BackupDiffNote {
  /** What a person calls the table. */
  table: string;
  count: number;
  reason: string;
}

/** A section of the data a restore can be limited to (wiki, notes, users ...). */
export interface BackupRestoreSection {
  key: string;
  title: string;
  description: string;
  /** What is in it, by table title. */
  tables: string[];
  /** Choosing it also covers the uploaded files. */
  hasFiles: boolean;
}

export interface BackupDiffReport {
  backupId: string;
  backupName: string;
  backupCreatedAt: string;
  generatedAt: string;
  compatibility: BackupCompatibility;
  /** The backup was made with a different AUTH_SECRET: encrypted settings will not decrypt. */
  secretMismatch: boolean;
  totals: { added: number; removed: number; changed: number; unchanged: number };
  groups: BackupDiffGroup[];
  /** Tables whose contents are identical to the backup (listed so the report is complete). */
  identicalTables: string[];
  files: BackupDiffFiles | null;
  /** What a restore does to the account of the person asking. */
  you: { status: "unchanged" | "changed" | "removed"; detail: string } | null;
  /** Which sections this report is about. Everything not listed is left exactly as it is. */
  scope: { partial: boolean; sections: string[] };
  /** Rows a restore cannot put back (a person or page they depend on is gone and was not included). */
  skipped: BackupDiffNote[];
  /** Rows a restore puts back without an optional link (a creator, an assignee) whose person is gone and was not included. */
  cleared?: BackupDiffNote[];
  /** Rows a restore would delete but keeps, because data that was not included still uses them. */
  kept: BackupDiffNote[];
}

/** The sections a restore or comparison covers (keys from the restore-sections list); leave out for everything. */
const sectionsSchema = z.array(z.string().min(1).max(60)).min(1).max(30).optional();

export const compareRequestSchema = z.object({ sections: sectionsSchema }).strict();
export type CompareRequest = z.infer<typeof compareRequestSchema>;

export const restoreRequestSchema = z
  .object({
    /** Restore only these sections; leave out for everything (a full rollback). */
    sections: sectionsSchema,
    confirm: z.literal(RESTORE_CONFIRM_PHRASE),
    /** Take a backup of the current state first, so the restore can be undone. Default true. */
    safetyBackup: z.boolean().default(true),
    /** Go ahead although the backup was made with a different AUTH_SECRET. */
    acceptSecretMismatch: z.boolean().default(false),
  })
  .strict();
export type RestoreRequest = z.infer<typeof restoreRequestSchema>;

export interface BackupRestoreResult {
  backupId: string;
  safetyBackupId: string | null;
  rowsAdded: number;
  rowsRemoved: number;
  rowsChanged: number;
  filesRestored: number;
  filesRemoved: number;
  /** Rows a partial restore could not put back, and rows it kept (see the comparison report). */
  rowsSkipped: number;
  rowsKept: number;
  /** The sections restored; null for everything. */
  sections: string[] | null;
  warnings: string[];
}

export interface BackupStorageInfo {
  count: number;
  totalBytes: number;
  /** Whether new backups can be stored (the object store answers). */
  available: boolean;
}
