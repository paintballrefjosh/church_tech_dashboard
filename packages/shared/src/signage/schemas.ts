import { z } from "zod";

/**
 * Signage (docs/signage.md): request schemas and the shapes the API returns. Times of day are wall-clock "HH:MM" on the
 * site's time zone (`site.timezone`), dates are DATE-ONLY "YYYY-MM-DD" on the same calendar, instants are ISO strings.
 */

export const SIGNAGE_LIMITS = {
  /** Largest upload accepted for one media file. */
  maxUploadBytes: 500 * 1024 * 1024,
  /** Days of timeline a manifest carries. */
  manifestDays: 14,
  /** Manifests kept per screen. */
  manifestsKept: 5,
  /** A display time for one item, in seconds. */
  minItemSeconds: 1,
  maxItemSeconds: 24 * 3600,
  /** Items in one playlist. */
  maxItems: 500,
  /** Largest subnet one scan may cover (a /22). */
  maxScanAddresses: 1024,
  /** Identify: how long the codes stay up by default, and the range allowed. */
  identifyDefaultSec: 60,
  identifyMinSec: 10,
  identifyMaxSec: 300,
  /** A device that has not answered this long while its screen should be on is offline. */
  offlineAfterMin: 5,
  /** Content more than this behind is a problem. */
  syncBehindMin: 60,
  /** Files bigger than this wait for the bulk window unless needed within a day. */
  bulkFileBytes: 50 * 1024 * 1024,
} as const;

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour time like 08:30");
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-08");
const name = z.string().trim().min(1, "A name is required").max(120);
const description = z.string().trim().max(1000);
const uuid = z.string().uuid();
const weekdays = z
  .array(z.number().int().min(1).max(7))
  .min(1, "Pick at least one day")
  .max(7)
  .transform((d) => [...new Set(d)].sort((a, b) => a - b));

export const SIGNAGE_ORIENTATIONS = ["landscape", "portrait"] as const;
export type SignageOrientation = (typeof SIGNAGE_ORIENTATIONS)[number];
export const SIGNAGE_TV_CONTROLS = ["roku_ecp", "cec", "none"] as const;
export type SignageTvControl = (typeof SIGNAGE_TV_CONTROLS)[number];
/** Inputs a Roku TV accepts as an ECP keypress, and the CEC driver's equivalents (HDMI port numbers). */
export const SIGNAGE_TV_INPUTS = ["InputHDMI1", "InputHDMI2", "InputHDMI3", "InputHDMI4", "InputAV1", "InputTuner"] as const;
export type SignageTvInput = (typeof SIGNAGE_TV_INPUTS)[number];
export const SIGNAGE_TARGET_TYPES = ["screen", "group", "all"] as const;
export type SignageTargetType = (typeof SIGNAGE_TARGET_TYPES)[number];

// ---------------------------------------------------------------- media

export const SIGNAGE_MEDIA_KINDS = ["image", "video"] as const;
export type SignageMediaKind = (typeof SIGNAGE_MEDIA_KINDS)[number];
export const SIGNAGE_MEDIA_STATUSES = ["uploaded", "processing", "ready", "failed", "missing"] as const;
export type SignageMediaStatus = (typeof SIGNAGE_MEDIA_STATUSES)[number];

export interface SignageMedia {
  id: string;
  name: string;
  kind: SignageMediaKind | null;
  status: SignageMediaStatus;
  originalName: string;
  sha256: string | null;
  width: number | null;
  height: number | null;
  durationS: number | null;
  sizeBytes: number | null;
  error: string | null;
  hasThumb: boolean;
  usedBy: Array<{ playlistId: string; playlistName: string }>;
  createdAt: string;
}

export const updateSignageMediaSchema = z.object({ name }).strict();
export type UpdateSignageMediaInput = z.infer<typeof updateSignageMediaSchema>;

// ---------------------------------------------------------------- playlists

export const signagePlaylistItemInputSchema = z
  .object({
    mediaId: uuid,
    /** null = the video's own length, or the playlist's image time. */
    durationS: z.number().min(SIGNAGE_LIMITS.minItemSeconds).max(SIGNAGE_LIMITS.maxItemSeconds).nullable().default(null),
    enabled: z.boolean().default(true),
    validFrom: dateOnly.nullable().default(null),
    validUntil: dateOnly.nullable().default(null),
  })
  .strict()
  .refine((i) => !i.validFrom || !i.validUntil || i.validFrom <= i.validUntil, { message: "The last day is before the first day" });
export type SignagePlaylistItemInput = z.infer<typeof signagePlaylistItemInputSchema>;

export const createSignagePlaylistSchema = z
  .object({
    name,
    description: description.default(""),
    defaultImageDurationS: z.number().min(SIGNAGE_LIMITS.minItemSeconds).max(3600).default(8),
    isAdhoc: z.boolean().default(false),
    items: z.array(signagePlaylistItemInputSchema).max(SIGNAGE_LIMITS.maxItems).default([]),
  })
  .strict();
export type CreateSignagePlaylistInput = z.infer<typeof createSignagePlaylistSchema>;

export const updateSignagePlaylistSchema = z
  .object({
    name: name.optional(),
    description: description.optional(),
    defaultImageDurationS: z.number().min(SIGNAGE_LIMITS.minItemSeconds).max(3600).optional(),
    isAdhoc: z.boolean().optional(),
    /** The whole item list, in order (reordering is sending it in the new order). */
    items: z.array(signagePlaylistItemInputSchema).max(SIGNAGE_LIMITS.maxItems).optional(),
  })
  .strict();
export type UpdateSignagePlaylistInput = z.infer<typeof updateSignagePlaylistSchema>;

export interface SignagePlaylistItem {
  id: string;
  mediaId: string;
  mediaName: string;
  mediaKind: SignageMediaKind | null;
  mediaStatus: SignageMediaStatus;
  mediaDurationS: number | null;
  hasThumb: boolean;
  position: number;
  durationS: number | null;
  enabled: boolean;
  validFrom: string | null;
  validUntil: string | null;
}

export interface SignagePlaylist {
  id: string;
  name: string;
  description: string;
  defaultImageDurationS: number;
  isAdhoc: boolean;
  items: SignagePlaylistItem[];
  /** Seconds one loop takes with every item that is on today. */
  loopSeconds: number;
  warnings: string[];
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------- screens and screen groups

export const createSignageScreenSchema = z
  .object({
    name,
    locationId: uuid.nullable().default(null),
    orientation: z.enum(SIGNAGE_ORIENTATIONS).default("landscape"),
    tvControl: z.enum(SIGNAGE_TV_CONTROLS).default("none"),
    rokuIp: z.string().ip({ version: "v4" }).nullable().default(null),
    hdmiInput: z.enum(SIGNAGE_TV_INPUTS).nullable().default(null),
    fallbackPlaylistId: uuid.nullable().default(null),
    groupIds: z.array(uuid).max(50).default([]),
    notes: description.default(""),
    enabled: z.boolean().default(true),
  })
  .strict();
export type CreateSignageScreenInput = z.infer<typeof createSignageScreenSchema>;

export const updateSignageScreenSchema = z
  .object({
    name: name.optional(),
    locationId: uuid.nullable().optional(),
    orientation: z.enum(SIGNAGE_ORIENTATIONS).optional(),
    tvControl: z.enum(SIGNAGE_TV_CONTROLS).optional(),
    rokuIp: z.string().ip({ version: "v4" }).nullable().optional(),
    hdmiInput: z.enum(SIGNAGE_TV_INPUTS).nullable().optional(),
    fallbackPlaylistId: uuid.nullable().optional(),
    groupIds: z.array(uuid).max(50).optional(),
    notes: description.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export type UpdateSignageScreenInput = z.infer<typeof updateSignageScreenSchema>;

export const signageScreenGroupSchema = z.object({ name, description: description.default("") }).strict();
export const updateSignageScreenGroupSchema = z.object({ name: name.optional(), description: description.optional() }).strict();
export type SignageScreenGroupInput = z.infer<typeof signageScreenGroupSchema>;

export interface SignageScreenGroup {
  id: string;
  name: string;
  description: string;
  screenCount: number;
}

export interface SignageNowPlaying {
  playlistId: string | null;
  playlistName: string | null;
  source: string;
  until: string | null;
}

export interface SignageScreen {
  id: string;
  name: string;
  locationId: string | null;
  locationName: string | null;
  orientation: SignageOrientation;
  tvControl: SignageTvControl;
  rokuIp: string | null;
  rokuSerial: string | null;
  hdmiInput: SignageTvInput | null;
  fallbackPlaylistId: string | null;
  groupIds: string[];
  notes: string;
  enabled: boolean;
  /** Set when a change is waiting to be compiled. */
  manifestDirty: boolean;
  manifestVersion: number | null;
  device: SignageDeviceSummary | null;
  now: SignageNowPlaying | null;
  powerNow: "on" | "off" | "unmanaged";
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------- schedules (one-time and repeating), power

const target = {
  targetType: z.enum(SIGNAGE_TARGET_TYPES),
  targetId: uuid.nullable().default(null),
};
const targetRefine = <T extends { targetType?: SignageTargetType; targetId?: string | null }>(v: T) =>
  v.targetType === undefined || (v.targetType === "all") === (v.targetId === null || v.targetId === undefined);
const targetMessage = { message: "Pick a screen or a screen group (or 'all screens' with no target)" };

/** One-time (two instants), weekly (days of the week) or monthly (e.g. the first and last Saturday). */
export const SIGNAGE_SCHEDULE_KINDS = ["once", "weekly", "monthly"] as const;
export type SignageScheduleKind = (typeof SIGNAGE_SCHEDULE_KINDS)[number];

/** Five levels, stored as 1-5. When two entries would show on the same screen at the same time, the higher one wins. */
export const SIGNAGE_PRIORITIES = [
  { value: 1, label: "Lowest" },
  { value: 2, label: "Low" },
  { value: 3, label: "Normal" },
  { value: 4, label: "High" },
  { value: 5, label: "Highest" },
] as const;
export const SIGNAGE_PRIORITY_DEFAULT = 3;
export function signagePriorityLabel(p: number): string {
  return SIGNAGE_PRIORITIES.find((x) => x.value === p)?.label ?? String(p);
}

/** Which weeks of the month a monthly entry repeats on: 1-4 = first to fourth, -1 = the last. */
export const SIGNAGE_MONTH_WEEKS = [1, 2, 3, 4, -1] as const;
const monthWeeks = z
  .array(z.number().int().refine((w) => (SIGNAGE_MONTH_WEEKS as readonly number[]).includes(w), "Weeks of the month are 1-4, or -1 for the last"))
  .max(5)
  .transform((w) => [...new Set(w)].sort((a, b) => (a === -1 ? 9 : a) - (b === -1 ? 9 : b)));
const instant = z.string().datetime({ offset: true });
const anyWeekdays = z
  .array(z.number().int().min(1).max(7))
  .max(7)
  .transform((d) => [...new Set(d)].sort((a, b) => a - b));

/** The fields of a schedule entry (also the MCP tool's input). Which ones matter depends on `kind`: see `signageScheduleProblem`. */
export const signageScheduleShape = {
  name,
  kind: z.enum(SIGNAGE_SCHEDULE_KINDS).default("weekly"),
  targetType: z.enum(SIGNAGE_TARGET_TYPES),
  targetId: uuid.nullable().default(null),
  playlistId: uuid,
  priority: z.number().int().min(1).max(5).default(SIGNAGE_PRIORITY_DEFAULT),
  /** once: when it starts and ends. */
  startsAt: instant.nullable().default(null),
  endsAt: instant.nullable().default(null),
  /** weekly and monthly: the days (1 = Monday ... 7 = Sunday), the local times, and optionally the first and last day. */
  daysOfWeek: anyWeekdays.default([]),
  monthWeeks: monthWeeks.nullable().default(null),
  startTime: hhmm.nullable().default(null),
  endTime: hhmm.nullable().default(null),
  startDate: dateOnly.nullable().default(null),
  endDate: dateOnly.nullable().default(null),
  forcePowerOn: z.boolean().default(false),
  enabled: z.boolean().default(true),
};

export const createSignageScheduleSchema = z
  .object(signageScheduleShape)
  .strict()
  .superRefine((v, ctx) => {
    const p = signageScheduleProblem(v);
    if (p) ctx.addIssue({ code: z.ZodIssueCode.custom, message: p });
  });
export type CreateSignageScheduleInput = z.infer<typeof createSignageScheduleSchema>;

export const updateSignageScheduleSchema = z
  .object({
    name: name.optional(),
    kind: z.enum(SIGNAGE_SCHEDULE_KINDS).optional(),
    targetType: z.enum(SIGNAGE_TARGET_TYPES).optional(),
    targetId: uuid.nullable().optional(),
    playlistId: uuid.optional(),
    priority: z.number().int().min(1).max(5).optional(),
    startsAt: instant.nullable().optional(),
    endsAt: instant.nullable().optional(),
    daysOfWeek: anyWeekdays.optional(),
    monthWeeks: monthWeeks.nullable().optional(),
    startTime: hhmm.nullable().optional(),
    endTime: hhmm.nullable().optional(),
    startDate: dateOnly.nullable().optional(),
    endDate: dateOnly.nullable().optional(),
    forcePowerOn: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export type UpdateSignageScheduleInput = z.infer<typeof updateSignageScheduleSchema>;

/** The fields a schedule entry is judged on (a stored row merged with a PATCH, or a create). */
export interface SignageScheduleRule {
  kind: SignageScheduleKind;
  targetType: SignageTargetType;
  targetId: string | null;
  startsAt: string | null;
  endsAt: string | null;
  daysOfWeek: number[];
  monthWeeks: number[] | null;
  startTime: string | null;
  endTime: string | null;
  startDate: string | null;
  endDate: string | null;
}

/** A one-time entry may last at most this long (a longer one is a recurring entry or the fallback playlist). */
export const SIGNAGE_ONCE_MAX_DAYS = 366;

/** What is wrong with an entry, in words, or null. */
export function signageScheduleProblem(v: SignageScheduleRule): string | null {
  if ((v.targetType === "all") !== (v.targetId === null || v.targetId === undefined)) return targetMessage.message;
  if (v.kind === "once") {
    if (!v.startsAt || !v.endsAt) return "A one-time entry needs a start and an end date and time";
    const a = Date.parse(v.startsAt);
    const b = Date.parse(v.endsAt);
    if (!(b > a)) return "It ends before it starts";
    if (b - a > SIGNAGE_ONCE_MAX_DAYS * 86_400_000) return `A one-time entry can last at most ${SIGNAGE_ONCE_MAX_DAYS} days; make it repeat instead`;
    return null;
  }
  if (!v.startTime || !v.endTime) return "A repeating entry needs a start and an end time";
  if (v.startTime === v.endTime) return "The start and end times are the same";
  if (!v.daysOfWeek.length) return "Pick at least one day";
  if (v.kind === "monthly" && !v.monthWeeks?.length) return "Pick which weeks of the month (first, second ... last)";
  if (v.startDate && v.endDate && v.startDate > v.endDate) return "The last day is before the first day";
  return null;
}

/** The entry with the fields its kind does not use cleared, as it is stored. */
export function normaliseSignageSchedule<T extends SignageScheduleRule>(v: T): T {
  if (v.kind === "once") return { ...v, daysOfWeek: [], monthWeeks: null, startTime: null, endTime: null, startDate: null, endDate: null, targetId: v.targetType === "all" ? null : v.targetId };
  return { ...v, startsAt: null, endsAt: null, monthWeeks: v.kind === "monthly" ? v.monthWeeks : null, targetId: v.targetType === "all" ? null : v.targetId };
}

export interface SignageSchedule extends SignageScheduleRule {
  id: string;
  name: string;
  targetName: string;
  playlistId: string;
  playlistName: string;
  /** 1 (lowest) to 5 (highest). */
  priority: number;
  forcePowerOn: boolean;
  enabled: boolean;
  /** One-time entries: by the clock. Repeating ones: "ended" once their last day has passed, otherwise null. */
  state: "upcoming" | "active" | "ended" | null;
  createdAt: string;
}

export const createSignagePowerScheduleSchema = z
  .object({
    name,
    ...target,
    daysOfWeek: weekdays,
    onTime: hhmm,
    offTime: hhmm,
    startDate: dateOnly.nullable().default(null),
    endDate: dateOnly.nullable().default(null),
    enabled: z.boolean().default(true),
  })
  .strict()
  .refine(targetRefine, targetMessage)
  .refine((s) => s.onTime !== s.offTime, { message: "The on and off times are the same" });
export type CreateSignagePowerScheduleInput = z.infer<typeof createSignagePowerScheduleSchema>;

export const updateSignagePowerScheduleSchema = z
  .object({
    name: name.optional(),
    targetType: z.enum(SIGNAGE_TARGET_TYPES).optional(),
    targetId: uuid.nullable().optional(),
    daysOfWeek: weekdays.optional(),
    onTime: hhmm.optional(),
    offTime: hhmm.optional(),
    startDate: dateOnly.nullable().optional(),
    endDate: dateOnly.nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export type UpdateSignagePowerScheduleInput = z.infer<typeof updateSignagePowerScheduleSchema>;

export interface SignagePowerSchedule {
  id: string;
  name: string;
  targetType: SignageTargetType;
  targetId: string | null;
  targetName: string;
  daysOfWeek: number[];
  onTime: string;
  offTime: string;
  startDate: string | null;
  endDate: string | null;
  enabled: boolean;
}

/** Re-check a create/update after merging it with the stored row (a PATCH may move only one end of a range). */
export function signageRangeProblem(v: { startTime?: string; endTime?: string; startDate?: string | null; endDate?: string | null; startsAt?: string; endsAt?: string; onTime?: string; offTime?: string; targetType?: string; targetId?: string | null }): string | null {
  if (v.startTime !== undefined && v.startTime === v.endTime) return "The start and end times are the same";
  if (v.onTime !== undefined && v.onTime === v.offTime) return "The on and off times are the same";
  if (v.startDate && v.endDate && v.startDate > v.endDate) return "The last day is before the first day";
  if (v.startsAt && v.endsAt && Date.parse(v.endsAt) <= Date.parse(v.startsAt)) return "The event ends before it starts";
  if (v.targetType !== undefined && (v.targetType === "all") !== (v.targetId === null || v.targetId === undefined)) return targetMessage.message;
  return null;
}

// ---------------------------------------------------------------- devices

/** `resetting`: Forget started the reset and the dashboard is waiting to see it finish (the row goes once it has). */
export const SIGNAGE_DEVICE_STATUSES = ["setting_up", "active", "failed", "disabled", "resetting"] as const;
export type SignageDeviceStatus = (typeof SIGNAGE_DEVICE_STATUSES)[number];

/** What `signage-ctl status` reports (all optional: an older agent may leave some out). */
export const signagePiStatusSchema = z
  .object({
    agentVersion: z.string().max(40).optional(),
    osVersion: z.string().max(120).optional(),
    model: z.string().max(120).optional(),
    serial: z.string().max(40).optional(),
    hostname: z.string().max(120).optional(),
    uptimeS: z.number().optional(),
    cpuTempC: z.number().nullable().optional(),
    cpuPct: z.number().min(0).max(100).nullable().optional(),
    throttled: z.string().max(20).nullable().optional(),
    underVoltage: z.boolean().optional(),
    diskFreeMb: z.number().nullable().optional(),
    diskTotalMb: z.number().nullable().optional(),
    memFreeMb: z.number().nullable().optional(),
    wifiSsid: z.string().max(64).nullable().optional(),
    wifiRssiDbm: z.number().nullable().optional(),
    wifiBand: z.string().max(10).nullable().optional(),
    clockSynced: z.boolean().optional(),
    clock: z.string().max(40).optional(),
    manifestVersion: z.number().int().nullable().optional(),
    manifestStaged: z.number().int().nullable().optional(),
    missingMedia: z.number().int().optional(),
    nowPlaying: z.object({ playlist: z.string().max(80).nullable(), media: z.string().max(80).nullable(), source: z.string().max(80).nullable() }).partial().nullable().optional(),
    playerRunning: z.boolean().optional(),
    tvPower: z.enum(["on", "standby", "unknown"]).optional(),
    tvInput: z.string().max(40).nullable().optional(),
    tvError: z.string().max(300).nullable().optional(),
    roku: z.object({ ip: z.string().max(45), serial: z.string().max(40).nullable().optional(), model: z.string().max(80).nullable().optional() }).nullable().optional(),
    displayMode: z.string().max(40).nullable().optional(),
    osUpdatesPending: z.number().int().nullable().optional(),
    osUpdateState: z.string().max(200).nullable().optional(),
    settingsHash: z.string().max(80).nullable().optional(),
    identifyUntil: z.string().max(40).nullable().optional(),
    lastError: z.string().max(500).nullable().optional(),
  })
  .passthrough();
export type SignagePiStatus = z.infer<typeof signagePiStatusSchema>;

export interface SignageDeviceSummary {
  id: string;
  name: string;
  ip: string;
  status: SignageDeviceStatus;
  online: boolean;
  lastSeenAt: string | null;
}

export interface SignageDeviceProblem {
  code: string;
  severity: "critical" | "warning" | "info";
  message: string;
}

/** What a Pi is showing, in words: the Pi only reports ids and a file hash, the dashboard looks the names up. */
export interface SignageDevicePlaying {
  /** `playlist`: a scheduled entry's playlist, `fallback`: the screen's fallback playlist, `logo`: the church logo slide (nothing to play). */
  kind: "playlist" | "fallback" | "logo";
  playlistName: string | null;
  mediaName: string | null;
  /** The schedule entry's name when the playlist came from one. */
  entryName: string | null;
}

export interface SignageDevice {
  id: string;
  name: string;
  screenId: string | null;
  screenName: string | null;
  ip: string;
  sshPort: number;
  hostKey: string | null;
  loginUser: string | null;
  keyGeneration: number | null;
  serial: string | null;
  model: string | null;
  osRelease: string | null;
  macWlan: string | null;
  macEth: string | null;
  agentVersion: string | null;
  status: SignageDeviceStatus;
  enabled: boolean;
  online: boolean;
  lastSeenAt: string | null;
  lastError: string | null;
  manifestVersionApplied: number | null;
  manifestVersionWanted: number | null;
  settingsApplied: boolean;
  latest: SignagePiStatus | null;
  /** What the Pi is showing now, named; null while it has reported nothing or its player is not running. */
  playing: SignageDevicePlaying | null;
  problems: SignageDeviceProblem[];
  identifyCode: string | null;
  identifyUntil: string | null;
  createdAt: string;
}

export const addSignageIpsSchema = z
  .object({ ips: z.array(z.string().ip({ version: "v4" })).min(1).max(64) })
  .strict();

export const signageDiscoverySubnetSchema = z
  .object({
    cidr: z.string().regex(/^\d{1,3}(\.\d{1,3}){3}\/(2[2-9]|3[0-2])$/, "Use a subnet like 10.20.30.0/24 (a /22 at most)"),
    continuous: z.boolean().default(false),
    intervalMin: z.number().int().min(15).max(24 * 60).default(60),
    label: z.string().trim().max(120).default(""),
  })
  .strict();
export type SignageDiscoverySubnetInput = z.infer<typeof signageDiscoverySubnetSchema>;
export const updateSignageDiscoverySubnetSchema = z
  .object({ continuous: z.boolean().optional(), intervalMin: z.number().int().min(15).max(24 * 60).optional(), label: z.string().trim().max(120).optional() })
  .strict();

export interface SignageDiscoverySubnet {
  id: string;
  cidr: string;
  label: string;
  continuous: boolean;
  intervalMin: number;
  lastRunAt: string | null;
  lastFound: number | null;
  running: boolean;
}

export const SIGNAGE_EVIDENCE = ["pi_mac", "name", "setup_banner", "ssh_debian", "ssh_other"] as const;
export type SignageEvidence = (typeof SIGNAGE_EVIDENCE)[number];

export interface SignageFoundPi {
  id: string;
  ip: string;
  hostKey: string | null;
  banner: string | null;
  evidence: SignageEvidence;
  evidenceText: string;
  mac: string | null;
  name: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  isNew: boolean;
  dismissed: boolean;
  /** An adopted device already has this host key (it moved address). */
  knownDeviceId: string | null;
}

export const signageSetupSchema = z
  .object({
    foundId: uuid.optional(),
    deviceId: uuid.optional(),
    name: name.optional(),
    screenId: uuid.nullable().optional(),
    newScreenName: z.string().trim().min(1).max(120).optional(),
    /** Only when the saved setup login is not the one for this Pi. Never stored. */
    username: z.string().trim().min(1).max(64).regex(/^[a-z_][a-z0-9_-]*$/, "Not a Linux user name").optional(),
    password: z.string().min(1).max(200).optional(),
    sudoPassword: z.string().min(1).max(200).optional(),
  })
  .strict()
  .refine((s) => !!s.foundId !== !!s.deviceId, { message: "Adopt either a found Pi or an existing device" });
export type SignageSetupInput = z.infer<typeof signageSetupSchema>;

export const signageShowCodeSchema = z
  .object({ username: z.string().trim().min(1).max(64).optional(), password: z.string().min(1).max(200).optional() })
  .strict();

/** "Show a code" is taken off the screen again when its window closes. `vt` is the text console the Pi was on before the code
 * switched a desktop Pi to console 1 (answered by show-code), so the screen can be switched back. */
export const signageClearCodeSchema = z
  .object({ username: z.string().trim().min(1).max(64).optional(), password: z.string().min(1).max(200).optional(), vt: z.number().int().min(1).max(63).optional() })
  .strict();

export const signageIdentifySchema = z
  .object({
    deviceIds: z.array(uuid).max(200).optional(),
    all: z.boolean().optional(),
    seconds: z.number().int().min(SIGNAGE_LIMITS.identifyMinSec).max(SIGNAGE_LIMITS.identifyMaxSec).default(SIGNAGE_LIMITS.identifyDefaultSec),
  })
  .strict()
  .refine((s) => s.all === true || (s.deviceIds?.length ?? 0) > 0, { message: "Pick at least one device" });
export type SignageIdentifyInput = z.infer<typeof signageIdentifySchema>;

export interface SignageIdentifyResult {
  until: string;
  devices: Array<{ deviceId: string; name: string; ip: string; code: string | null; error: string | null }>;
}

export const updateSignageDeviceSchema = z
  .object({ name: name.optional(), screenId: uuid.nullable().optional(), enabled: z.boolean().optional() })
  .strict();

export const SIGNAGE_COMMANDS = ["sync_now", "restart_player", "restart_agent", "reboot", "tv_power", "tv_input", "tv_state", "diag", "os_update", "agent_update"] as const;
export type SignageCommand = (typeof SIGNAGE_COMMANDS)[number];
export const signageCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("sync_now") }).strict(),
  z.object({ type: z.literal("restart_player") }).strict(),
  z.object({ type: z.literal("restart_agent") }).strict(),
  z.object({ type: z.literal("reboot") }).strict(),
  z.object({ type: z.literal("tv_power"), state: z.enum(["on", "off"]) }).strict(),
  z.object({ type: z.literal("tv_input"), input: z.enum(SIGNAGE_TV_INPUTS) }).strict(),
  z.object({ type: z.literal("tv_state") }).strict(),
  z.object({ type: z.literal("diag") }).strict(),
  z.object({ type: z.literal("os_update") }).strict(),
  z.object({ type: z.literal("agent_update") }).strict(),
]);
export type SignageCommandInput = z.infer<typeof signageCommandSchema>;

export interface SignageCommandResult {
  ok: boolean;
  message: string;
  via: "pi" | "roku" | null;
  output?: unknown;
}

export const signageScreenTvSchema = z
  .object({ action: z.enum(["on", "off", "input", "state"]), input: z.enum(SIGNAGE_TV_INPUTS).optional() })
  .strict()
  .refine((t) => t.action !== "input" || !!t.input, { message: "Pick an input" });

export const signagePowerAllSchema = z.object({ state: z.enum(["on", "off"]), groupId: uuid.nullable().default(null) }).strict();

export const SIGNAGE_RUN_KINDS = ["setup", "apply", "os_update", "agent_update", "show_code", "forget"] as const;
export type SignageRunKind = (typeof SIGNAGE_RUN_KINDS)[number];
export const SIGNAGE_RUN_STATUSES = ["queued", "running", "succeeded", "failed", "needs_sudo"] as const;
export type SignageRunStatus = (typeof SIGNAGE_RUN_STATUSES)[number];

export interface SignageSetupRun {
  id: string;
  deviceId: string | null;
  deviceName: string | null;
  ip: string;
  kind: SignageRunKind;
  status: SignageRunStatus;
  step: string | null;
  output: string;
  error: string | null;
  startedBy: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface SignageAgentRelease {
  id: string;
  version: string;
  sha256: string;
  sizeBytes: number;
  notes: string;
  isCurrent: boolean;
  builtIn: boolean;
  createdAt: string;
  devices: number;
}

export const signageReleaseSchema = z.object({ notes: z.string().trim().max(2000).default("") }).strict();

export interface SignageKeyInfo {
  generation: number;
  publicKey: string;
  fingerprint: string;
  devicesOnOldKey: number;
}

/** A timeline entry as the UI draws it (the manifest's own entries plus names). */
export interface SignageTimelineEntry {
  start: string;
  end: string;
  playlistId: string | null;
  playlistName: string | null;
  source: string;
  sourceName: string;
}

export interface SignagePreview {
  at: string;
  playlistId: string | null;
  playlistName: string | null;
  source: string;
  why: string;
  candidates: Array<{ source: string; name: string; playlistName: string; won: boolean; note: string | null }>;
  items: Array<{ mediaId: string; name: string; kind: SignageMediaKind; seconds: number }>;
  power: "on" | "off" | "unmanaged";
}
