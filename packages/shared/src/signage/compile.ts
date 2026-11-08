import { addDaysInZone, startOfDayInZone, zonedParts, zonedTimeToUtc } from "../dashboard/zoned";
import { SIGNAGE_LIMITS, type SignageMediaKind, type SignageMediaStatus, type SignageOrientation, type SignageTargetType, type SignageTvControl } from "./schemas";

/**
 * The manifest compiler (docs/signage.md section 9). Pure: rows in, the manifest a Pi plays out. The preview and the timeline
 * routes use the same functions, so the dashboard shows exactly what the TV will do.
 *
 * At any instant a screen shows the first candidate that has something to play:
 *   1. an active event (override) on the screen, one of its screen groups, or all screens: highest priority first, then the
 *      most specific target (screen, group, all), then the newest;
 *   2. a schedule on the screen: highest priority first, then the newest;
 *   3. a schedule on one of its screen groups: highest priority first, then the group whose id sorts first (a tie the UI
 *      warns about), then the newest;
 *   4. the screen's fallback playlist;
 *   5. nothing: the Pi shows its built-in logo slide.
 * A playlist whose items are all off, outside their dates, or not ready yet has nothing to play and falls through.
 *
 * Power: when any power schedule applies to the screen (on the screen, a group of it, or all screens), the TV is on during
 * the union of their on-windows and off outside them; an event with `forcePowerOn` adds its own window. With none, the
 * manifest says nothing about power and the Pi leaves the TV alone.
 */

export interface CompileMedia {
  id: string;
  sha256: string | null;
  kind: SignageMediaKind | null;
  durationS: number | null;
  sizeBytes: number | null;
  status: SignageMediaStatus;
}

export interface CompilePlaylistItem {
  mediaId: string;
  durationS: number | null;
  enabled: boolean;
  validFrom: string | null;
  validUntil: string | null;
}

export interface CompilePlaylist {
  id: string;
  name: string;
  defaultImageDurationS: number;
  items: CompilePlaylistItem[];
}

export interface CompileSchedule {
  id: string;
  name: string;
  targetType: "screen" | "group";
  targetId: string;
  playlistId: string;
  priority: number;
  daysOfWeek: number[];
  startTime: string;
  endTime: string;
  startDate: string | null;
  endDate: string | null;
  enabled: boolean;
  createdAt: Date;
}

export interface CompileOverride {
  id: string;
  name: string;
  targetType: SignageTargetType;
  targetId: string | null;
  playlistId: string;
  startsAt: Date;
  endsAt: Date;
  priority: number;
  forcePowerOn: boolean;
  createdAt: Date;
}

export interface CompilePowerSchedule {
  id: string;
  name: string;
  targetType: SignageTargetType;
  targetId: string | null;
  daysOfWeek: number[];
  onTime: string;
  offTime: string;
  startDate: string | null;
  endDate: string | null;
  enabled: boolean;
}

export interface CompileScreen {
  id: string;
  name: string;
  groupIds: string[];
  fallbackPlaylistId: string | null;
  orientation: SignageOrientation;
  tvControl: SignageTvControl;
  rokuIp: string | null;
  hdmiInput: string | null;
}

export interface CompileInput {
  screen: CompileScreen;
  playlists: Record<string, CompilePlaylist>;
  media: Record<string, CompileMedia>;
  schedules: CompileSchedule[];
  overrides: CompileOverride[];
  power: CompilePowerSchedule[];
  timezone: string;
}

export interface ManifestItem {
  /** sha256 of the file. */
  m: string;
  /** Seconds on screen. */
  dur: number;
  kind: SignageMediaKind;
}

export interface ManifestTimelineEntry {
  start: string;
  end: string;
  playlist: string;
  /** `override:<id>`, `schedule:<id>`, `group-schedule:<id>` or `fallback`. */
  source: string;
}

export interface SignageManifest {
  format: 1;
  version: number;
  screenId: string;
  generatedAt: string;
  validFrom: string;
  validUntil: string;
  timezone: string;
  orientation: SignageOrientation;
  media: Record<string, { kind: SignageMediaKind; bytes: number }>;
  playlists: Record<string, ManifestItem[]>;
  /** Contiguous, non-overlapping; time not covered shows the built-in logo slide. */
  timeline: ManifestTimelineEntry[];
  /** What to play before the clock is synced (the fallback as it is at `validFrom`). */
  fallbackPlaylist: string | null;
  /** null = power is not managed for this screen. */
  powerInitial: "on" | "off" | null;
  power: Array<{ at: string; state: "on" | "off" }>;
  tv: { control: SignageTvControl; rokuIp: string | null; input: string | null };
}

export interface Candidate {
  source: string;
  name: string;
  playlistId: string;
  /** null = it has something to play; otherwise why it was passed over. */
  empty: string | null;
}

interface Interval {
  start: number;
  end: number;
}

const DAY_MS = 86_400_000;

function hm(t: string): [number, number] {
  const [h, m] = t.split(":").map(Number);
  return [h ?? 0, m ?? 0];
}

/** "YYYY-MM-DD" on the zone's calendar. */
export function localDate(at: Date | number, tz: string): string {
  const p = zonedParts(new Date(at), tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/**
 * The concrete windows of a weekly rule between `from` and `to`. A window belongs to the day it starts on (its weekday and
 * date range are judged on that day); an end at or before the start means the next day (it crosses midnight).
 */
export function weeklyWindows(rule: { daysOfWeek: number[]; start: string; end: string; startDate: string | null; endDate: string | null }, from: Date, to: Date, tz: string): Interval[] {
  const out: Interval[] = [];
  const [sh, sm] = hm(rule.start);
  const [eh, em] = hm(rule.end);
  const crosses = eh * 60 + em <= sh * 60 + sm;
  const firstDay = startOfDayInZone(new Date(from.getTime() - DAY_MS), tz);
  const days = Math.ceil((to.getTime() - firstDay.getTime()) / DAY_MS) + 1;
  for (let k = 0; k <= days; k++) {
    const day = addDaysInZone(firstDay, tz, k);
    const p = zonedParts(day, tz);
    if (!rule.daysOfWeek.includes(p.weekday)) continue;
    const date = localDate(day, tz);
    if (rule.startDate && date < rule.startDate) continue;
    if (rule.endDate && date > rule.endDate) continue;
    const start = zonedTimeToUtc(tz, p.year, p.month, p.day, sh, sm).getTime();
    const end = zonedTimeToUtc(tz, p.year, p.month, p.day + (crosses ? 1 : 0), eh, em).getTime();
    if (end <= from.getTime() || start >= to.getTime() || end <= start) continue;
    out.push({ start, end });
  }
  return out;
}

function within(ivs: Interval[], t: number): boolean {
  return ivs.some((i) => i.start <= t && t < i.end);
}

/** Small stable hash for playlist variant keys (not security). */
function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export interface CompiledPlaylist {
  key: string;
  items: ManifestItem[];
  /** Media named by the playlist that cannot be played yet (not ready, failed, missing). */
  skipped: number;
}

/** A playlist as it plays on `date`: items that are on, inside their dates and ready, with their seconds. */
export function compilePlaylist(pl: CompilePlaylist, media: Record<string, CompileMedia>, date: string): CompiledPlaylist {
  const items: ManifestItem[] = [];
  let skipped = 0;
  for (const it of pl.items) {
    if (!it.enabled) continue;
    if (it.validFrom && date < it.validFrom) continue;
    if (it.validUntil && date > it.validUntil) continue;
    const m = media[it.mediaId];
    if (!m || m.status !== "ready" || !m.sha256 || !m.kind) {
      skipped++;
      continue;
    }
    const dur = it.durationS ?? (m.kind === "video" ? (m.durationS ?? pl.defaultImageDurationS) : pl.defaultImageDurationS);
    items.push({ m: m.sha256, dur: Math.max(SIGNAGE_LIMITS.minItemSeconds, Math.round(dur * 10) / 10), kind: m.kind });
  }
  const sig = items.map((i) => `${i.m}:${i.dur}`).join("|");
  return { key: `${pl.id}~${shortHash(sig)}`, items, skipped };
}

interface Prepared {
  input: CompileInput;
  overrides: Array<CompileOverride & { level: number }>;
  schedules: Array<{ s: CompileSchedule; ivs: Interval[]; level: number }>;
  powerIvs: Interval[];
  powerManaged: boolean;
}

function levelOf(targetType: SignageTargetType, targetId: string | null, screen: CompileScreen): number | null {
  if (targetType === "screen") return targetId === screen.id ? 0 : null;
  if (targetType === "group") return targetId && screen.groupIds.includes(targetId) ? 1 : null;
  return 2;
}

function prepare(input: CompileInput, from: Date, to: Date): Prepared {
  const { screen, timezone } = input;
  const overrides = input.overrides
    .map((o) => ({ ...o, level: levelOf(o.targetType, o.targetId, screen) }))
    .filter((o): o is CompileOverride & { level: number } => o.level !== null && o.endsAt.getTime() > from.getTime() && o.startsAt.getTime() < to.getTime());
  const schedules = input.schedules
    .filter((s) => s.enabled)
    .map((s) => ({ s, level: levelOf(s.targetType, s.targetId, screen) }))
    .filter((x): x is { s: CompileSchedule; level: number } => x.level !== null)
    .map(({ s, level }) => ({ s, level, ivs: weeklyWindows({ daysOfWeek: s.daysOfWeek, start: s.startTime, end: s.endTime, startDate: s.startDate, endDate: s.endDate }, from, to, timezone) }));
  const powerRules = input.power.filter((p) => p.enabled && levelOf(p.targetType, p.targetId, screen) !== null);
  const powerIvs: Interval[] = [];
  for (const p of powerRules) powerIvs.push(...weeklyWindows({ daysOfWeek: p.daysOfWeek, start: p.onTime, end: p.offTime, startDate: p.startDate, endDate: p.endDate }, from, to, timezone));
  const forced = overrides.filter((o) => o.forcePowerOn);
  for (const o of forced) powerIvs.push({ start: o.startsAt.getTime(), end: o.endsAt.getTime() });
  return { input, overrides, schedules, powerIvs, powerManaged: powerRules.length > 0 || forced.length > 0 };
}

/** Every candidate at instant `t`, best first, each marked with whether it has anything to play. */
function candidatesAt(p: Prepared, t: number): Array<Candidate & { compiled: CompiledPlaylist | null }> {
  const { input } = p;
  const date = localDate(t, input.timezone);
  const out: Array<Candidate & { compiled: CompiledPlaylist | null }> = [];
  const push = (source: string, name: string, playlistId: string) => {
    const pl = input.playlists[playlistId];
    if (!pl) {
      out.push({ source, name, playlistId, empty: "its playlist no longer exists", compiled: null });
      return;
    }
    const compiled = compilePlaylist(pl, input.media, date);
    out.push({ source, name, playlistId, empty: compiled.items.length ? null : compiled.skipped ? "none of its items are ready yet" : "it has nothing to play today", compiled: compiled.items.length ? compiled : null });
  };
  const ov = p.overrides
    .filter((o) => o.startsAt.getTime() <= t && t < o.endsAt.getTime())
    .sort((a, b) => b.priority - a.priority || a.level - b.level || b.createdAt.getTime() - a.createdAt.getTime());
  for (const o of ov) push(`override:${o.id}`, o.name, o.playlistId);
  const screenScheds = p.schedules
    .filter((x) => x.level === 0 && within(x.ivs, t))
    .sort((a, b) => b.s.priority - a.s.priority || b.s.createdAt.getTime() - a.s.createdAt.getTime());
  for (const x of screenScheds) push(`schedule:${x.s.id}`, x.s.name, x.s.playlistId);
  const groupScheds = p.schedules
    .filter((x) => x.level === 1 && within(x.ivs, t))
    .sort((a, b) => b.s.priority - a.s.priority || a.s.targetId.localeCompare(b.s.targetId) || b.s.createdAt.getTime() - a.s.createdAt.getTime());
  for (const x of groupScheds) push(`group-schedule:${x.s.id}`, x.s.name, x.s.playlistId);
  if (input.screen.fallbackPlaylistId) push("fallback", "Fallback playlist", input.screen.fallbackPlaylistId);
  return out;
}

export interface ResolveResult {
  winner: (Candidate & { items: ManifestItem[] }) | null;
  candidates: Candidate[];
  power: "on" | "off" | "unmanaged";
}

/** What the screen shows at `at`, and every rule that was considered (for the preview's "why"). */
export function resolveAt(input: CompileInput, at: Date): ResolveResult {
  const p = prepare(input, new Date(at.getTime() - DAY_MS), new Date(at.getTime() + DAY_MS));
  const cands = candidatesAt(p, at.getTime());
  const win = cands.find((c) => c.empty === null) ?? null;
  return {
    winner: win ? { source: win.source, name: win.name, playlistId: win.playlistId, empty: null, items: win.compiled!.items } : null,
    candidates: cands.map(({ compiled: _c, ...c }) => c),
    power: p.powerManaged ? (within(p.powerIvs, at.getTime()) ? "on" : "off") : "unmanaged",
  };
}

export interface CompileResult {
  manifest: SignageManifest;
  /** Ties and other things worth an admin's look, in words. */
  warnings: string[];
}

/** The 14-day manifest for one screen, starting at `from`. */
export function compileManifest(input: CompileInput, opts: { from: Date; version: number; generatedAt?: Date; days?: number }): CompileResult {
  const tz = input.timezone;
  const from = opts.from;
  const to = addDaysInZone(from, tz, opts.days ?? SIGNAGE_LIMITS.manifestDays);
  const p = prepare(input, from, to);
  const warnings = new Set<string>();

  // Every instant where the answer can change: rule edges and each local midnight (item date windows).
  const edges = new Set<number>([from.getTime(), to.getTime()]);
  for (const o of p.overrides) for (const t of [o.startsAt.getTime(), o.endsAt.getTime()]) edges.add(t);
  for (const x of p.schedules) for (const iv of x.ivs) edges.add(iv.start).add(iv.end);
  for (let d = startOfDayInZone(from, tz); d.getTime() < to.getTime(); d = addDaysInZone(d, tz, 1)) edges.add(d.getTime());
  const points = [...edges].filter((t) => t >= from.getTime() && t <= to.getTime()).sort((a, b) => a - b);

  const playlists: Record<string, ManifestItem[]> = {};
  const timeline: ManifestTimelineEntry[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (b <= a) continue;
    const cands = candidatesAt(p, a);
    const win = cands.find((c) => c.empty === null);
    const tie = tieWarning(p, a, input.screen.name);
    if (tie) warnings.add(tie);
    if (!win) continue;
    playlists[win.compiled!.key] = win.compiled!.items;
    const last = timeline[timeline.length - 1];
    if (last && last.source === win.source && last.playlist === win.compiled!.key && Date.parse(last.end) === a) last.end = new Date(b).toISOString();
    else timeline.push({ start: new Date(a).toISOString(), end: new Date(b).toISOString(), playlist: win.compiled!.key, source: win.source });
  }

  let fallbackKey: string | null = null;
  if (input.screen.fallbackPlaylistId && input.playlists[input.screen.fallbackPlaylistId]) {
    const fb = compilePlaylist(input.playlists[input.screen.fallbackPlaylistId]!, input.media, localDate(from, tz));
    if (fb.items.length) {
      playlists[fb.key] = fb.items;
      fallbackKey = fb.key;
    }
  }

  const media: SignageManifest["media"] = {};
  const bytesBySha = new Map<string, number>();
  for (const m of Object.values(input.media)) if (m.sha256 && m.sizeBytes !== null) bytesBySha.set(m.sha256, m.sizeBytes);
  for (const items of Object.values(playlists)) for (const it of items) media[it.m] = { kind: it.kind, bytes: bytesBySha.get(it.m) ?? 0 };

  const power: SignageManifest["power"] = [];
  let powerInitial: SignageManifest["powerInitial"] = null;
  if (p.powerManaged) {
    const merged = mergeIntervals(p.powerIvs);
    powerInitial = within(merged, from.getTime()) ? "on" : "off";
    for (const iv of merged) {
      if (iv.start > from.getTime() && iv.start < to.getTime()) power.push({ at: new Date(iv.start).toISOString(), state: "on" });
      if (iv.end > from.getTime() && iv.end < to.getTime()) power.push({ at: new Date(iv.end).toISOString(), state: "off" });
    }
    power.sort((x, y) => x.at.localeCompare(y.at));
  }

  const { screen } = input;
  return {
    manifest: {
      format: 1,
      version: opts.version,
      screenId: screen.id,
      generatedAt: (opts.generatedAt ?? new Date()).toISOString(),
      validFrom: from.toISOString(),
      validUntil: to.toISOString(),
      timezone: tz,
      orientation: screen.orientation,
      media,
      playlists,
      timeline,
      fallbackPlaylist: fallbackKey,
      powerInitial,
      power,
      tv: { control: screen.tvControl, rokuIp: screen.tvControl === "roku_ecp" ? screen.rokuIp : null, input: screen.hdmiInput },
    },
    warnings: [...warnings],
  };
}

function mergeIntervals(ivs: Interval[]): Interval[] {
  const sorted = [...ivs].sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else out.push({ ...iv });
  }
  return out;
}

/** Two group schedules of the same priority, from different groups, both active: the one whose group sorts first wins. */
function tieWarning(p: Prepared, t: number, screenName: string): string | null {
  const active = p.schedules.filter((x) => x.level === 1 && within(x.ivs, t)).sort((a, b) => b.s.priority - a.s.priority);
  const top = active[0];
  if (!top) return null;
  const rival = active.find((x) => x !== top && x.s.priority === top.s.priority && x.s.targetId !== top.s.targetId);
  if (!rival) return null;
  const [win, lose] = top.s.targetId.localeCompare(rival.s.targetId) <= 0 ? [top, rival] : [rival, top];
  return `On ${screenName}, the schedules "${win.s.name}" and "${lose.s.name}" have the same priority at the same time; "${win.s.name}" wins. Give one a higher priority to choose.`;
}

/** The TV power state the manifest wants at `at` (null when power is not managed). */
export function manifestPowerAt(m: Pick<SignageManifest, "powerInitial" | "power">, at: Date): "on" | "off" | null {
  if (m.powerInitial === null) return null;
  let state = m.powerInitial;
  for (const e of m.power) {
    if (Date.parse(e.at) > at.getTime()) break;
    state = e.state;
  }
  return state;
}

/** The timeline entry playing at `at`, if any. */
export function manifestEntryAt(m: Pick<SignageManifest, "timeline">, at: Date): ManifestTimelineEntry | null {
  const t = at.getTime();
  return m.timeline.find((e) => Date.parse(e.start) <= t && t < Date.parse(e.end)) ?? null;
}

/** The manifest without the fields that change on every compile, for "did anything change?". */
export function manifestContent(m: SignageManifest): string {
  const { version: _v, generatedAt: _g, ...rest } = m;
  return JSON.stringify(rest);
}
