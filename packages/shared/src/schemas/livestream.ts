import { z } from "zod";
import { monitorScheduleProblem } from "../monitor-schedule";

/**
 * Livestream checks (docs/livestreams.md): is each stream live, and does it carry a moving picture and sound? The API's
 * `livestream-checks` job reads the stream itself (yt-dlp finds it on a public page, or a private direct link is given) and
 * samples a few seconds with ffmpeg. Everything that decides something is a pure function here, unit-tested in
 * apps/api/test/livestreams.test.ts against real ffmpeg and yt-dlp output.
 */

export const LIVESTREAM_PLATFORMS = ["youtube", "facebook", "resi", "boxcast", "vimeo", "twitch", "subsplash", "other"] as const;
export type LivestreamPlatform = (typeof LIVESTREAM_PLATFORMS)[number];

export interface LivestreamPlatformInfo {
  label: string;
  /** What to paste for a public stream, shown under the field. */
  publicHint: string;
  /** What a private stream needs, shown when "private" is chosen. */
  privateHint: string;
  /** yt-dlp can find the stream on the public page (otherwise the public "page" must already be the stream's own link). */
  pageResolves: boolean;
  /** The platform's own API (set up in the Livestreams settings) can also say whether it is live. */
  api: boolean;
  /** What `platformRef` means for this platform, or null when it has none. */
  refLabel: string | null;
}

export const LIVESTREAM_PLATFORM_INFO: Record<LivestreamPlatform, LivestreamPlatformInfo> = {
  youtube: {
    label: "YouTube",
    publicHint: "The channel's live page (https://www.youtube.com/@yourchurch/live) or a watch link.",
    privateHint: "An unlisted stream: paste its watch link. Private (sign-in only) streams cannot be read.",
    pageResolves: true,
    api: true,
    refLabel: null,
  },
  facebook: {
    label: "Facebook",
    publicHint: "The page's live videos (https://www.facebook.com/yourchurch/live) or a video link.",
    privateHint: "Facebook offers no link to a private stream: with a page token in the settings, only whether it is live is checked.",
    pageResolves: true,
    api: true,
    refLabel: "Facebook page ID (for the API)",
  },
  resi: {
    label: "Resi",
    publicHint: "Resi's web player has no public page to read: paste the stream's HLS link (ends in .m3u8).",
    privateHint: "The stream's HLS link (.m3u8) from Resi Studio or the web player.",
    pageResolves: false,
    api: true,
    refLabel: "Resi encoder (for the Go Live API)",
  },
  boxcast: {
    label: "BoxCast",
    publicHint: "The broadcast's or channel's BoxCast page, or its HLS link (.m3u8).",
    privateHint: "The broadcast's HLS link (.m3u8).",
    pageResolves: true,
    api: false,
    refLabel: null,
  },
  vimeo: {
    label: "Vimeo",
    publicHint: "The event's page (https://vimeo.com/event/...).",
    privateHint: "The event's private link (with its hash), or its HLS link.",
    pageResolves: true,
    api: false,
    refLabel: null,
  },
  twitch: {
    label: "Twitch",
    publicHint: "The channel (https://www.twitch.tv/yourchurch).",
    privateHint: "Twitch streams are public; use the channel link.",
    pageResolves: true,
    api: true,
    refLabel: null,
  },
  subsplash: {
    label: "Subsplash",
    publicHint: "The stream's Subsplash page, or its HLS link (.m3u8).",
    privateHint: "The stream's HLS link (.m3u8).",
    pageResolves: true,
    api: false,
    refLabel: null,
  },
  other: {
    label: "Other (stream link)",
    publicHint: "The stream's own HLS (.m3u8) or DASH (.mpd) link: Dacast, StreamSpot, your own website's player ...",
    privateHint: "The stream's HLS (.m3u8) or DASH (.mpd) link, with any token it needs.",
    pageResolves: false,
    api: false,
    refLabel: null,
  },
};

export const LIVESTREAM_ACCESS = ["public", "private"] as const;
export type LivestreamAccess = (typeof LIVESTREAM_ACCESS)[number];

/** Limits on the two clocks: the cheap "is it live" check and the sound-and-picture sample. */
export const LIVESTREAM_LIMITS = {
  statusMinSec: 30,
  statusMaxSec: 3600,
  sampleMinSec: 60,
  sampleMaxSec: 3600,
  sampleSecondsMin: 5,
  sampleSecondsMax: 30,
  /** A bad sample is checked again this soon before anyone is told. */
  confirmAfterSec: 30,
} as const;

/** A link the server may fetch: http(s) only, no credentials in the address. Link-local and loopback are refused after DNS too. */
export function streamUrlProblem(raw: string): string | null {
  const text = raw.trim();
  if (!text) return "A link is needed.";
  if (text.length > 4000) return "The link is too long.";
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return "That is not a web address.";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "The link must start with https:// or http://.";
  if (u.username || u.password) return "Put no user name or password in the link.";
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || blockedAddress(host)) return "That address is not allowed.";
  // A one-word name (`api`, `meilisearch`) is one of this stack's own containers, never a stream: use the encoder's full
  // name or its address.
  if (!host.includes(".") && !host.includes(":")) return "Use the full host name or the address.";
  return null;
}

/** Loopback, link-local (cloud metadata), unspecified. Private LAN ranges are allowed: an encoder's own HLS output lives there. */
export function blockedAddress(ip: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return a === 127 || a === 0 || (a === 169 && b === 254);
  }
  const v6 = ip.toLowerCase();
  if (v6 === "::1" || v6 === "::") return true;
  if (/^fe[89ab][0-9a-f]:/.test(v6)) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return blockedAddress(mapped[1]!);
  // The same in hex, as `new URL` writes it: [::ffff:127.0.0.1] becomes ::ffff:7f00:1.
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
  if (hex) {
    const hi = parseInt(hex[1]!, 16);
    const lo = parseInt(hex[2]!, 16);
    return blockedAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return false;
}

const urlField = z.string().trim().max(4000);

const baseFields = {
  name: z.string().trim().min(1, "A name is needed").max(120),
  platform: z.enum(LIVESTREAM_PLATFORMS),
  access: z.enum(LIVESTREAM_ACCESS).default("public"),
  pageUrl: urlField.default(""),
  platformRef: z.string().trim().max(200).default(""),
  statusIntervalSec: z.number().int().min(LIVESTREAM_LIMITS.statusMinSec).max(LIVESTREAM_LIMITS.statusMaxSec).default(60),
  sampleIntervalSec: z.number().int().min(LIVESTREAM_LIMITS.sampleMinSec).max(LIVESTREAM_LIMITS.sampleMaxSec).default(300),
  sampleSeconds: z.number().int().min(LIVESTREAM_LIMITS.sampleSecondsMin).max(LIVESTREAM_LIMITS.sampleSecondsMax).default(10),
  schedule: z.string().max(500).default(""),
  graceMin: z.number().int().min(0).max(120).default(5),
  silenceDb: z.number().int().min(-90).max(-20).default(-50),
  checkVideo: z.boolean().default(true),
  alertGroupId: z.string().uuid().nullable().default(null),
  encoderMonitorId: z.string().uuid().nullable().default(null),
  enabled: z.boolean().default(true),
};

function refine<T extends z.ZodTypeAny>(schema: T) {
  return schema.superRefine((v: { schedule?: string; pageUrl?: string; streamUrl?: string | null }, ctx) => {
    const sched = monitorScheduleProblem(v.schedule);
    if (sched) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["schedule"], message: sched });
    if (v.pageUrl) {
      const p = streamUrlProblem(v.pageUrl);
      if (p) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["pageUrl"], message: p });
    }
    if (typeof v.streamUrl === "string" && v.streamUrl !== "" && v.streamUrl !== SAVED_SECRET) {
      const p = streamUrlProblem(v.streamUrl);
      if (p) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["streamUrl"], message: p });
    }
  });
}

/** What the form sends for a saved private link that was not retyped. */
export const SAVED_SECRET = "[saved]";

export const createLivestreamSchema = refine(
  z.object({
    ...baseFields,
    /** The private direct link. Stored encrypted, never returned (`hasStreamUrl`). */
    streamUrl: urlField.nullable().default(null),
  }),
);
export type CreateLivestreamInput = z.infer<typeof createLivestreamSchema>;

/** Every field optional. `streamUrl`: absent or "[saved]" keeps the saved link, "" or null removes it. */
export const updateLivestreamSchema = refine(
  z.object({
    name: baseFields.name.optional(),
    platform: z.enum(LIVESTREAM_PLATFORMS).optional(),
    access: z.enum(LIVESTREAM_ACCESS).optional(),
    pageUrl: urlField.optional(),
    platformRef: z.string().trim().max(200).optional(),
    statusIntervalSec: z.number().int().min(LIVESTREAM_LIMITS.statusMinSec).max(LIVESTREAM_LIMITS.statusMaxSec).optional(),
    sampleIntervalSec: z.number().int().min(LIVESTREAM_LIMITS.sampleMinSec).max(LIVESTREAM_LIMITS.sampleMaxSec).optional(),
    sampleSeconds: z.number().int().min(LIVESTREAM_LIMITS.sampleSecondsMin).max(LIVESTREAM_LIMITS.sampleSecondsMax).optional(),
    schedule: z.string().max(500).optional(),
    graceMin: z.number().int().min(0).max(120).optional(),
    silenceDb: z.number().int().min(-90).max(-20).optional(),
    checkVideo: z.boolean().optional(),
    alertGroupId: z.string().uuid().nullable().optional(),
    encoderMonitorId: z.string().uuid().nullable().optional(),
    enabled: z.boolean().optional(),
    streamUrl: urlField.nullable().optional(),
  }),
);
export type UpdateLivestreamInput = z.infer<typeof updateLivestreamSchema>;

/** What a stream needs before it can be checked at all, or null when it is ready. Judged on the merged row. */
export function livestreamSetupProblem(v: { platform: LivestreamPlatform; access: LivestreamAccess; pageUrl: string; hasStreamUrl: boolean; platformRef: string }): string | null {
  const info = LIVESTREAM_PLATFORM_INFO[v.platform];
  if (v.access === "private") {
    if (v.hasStreamUrl) return null;
    if (v.platform === "facebook" && v.platformRef) return null;
    if (v.platform === "youtube" && v.pageUrl) return null;
    return v.platform === "facebook" ? "A private Facebook stream needs the page ID (and a page token in the settings)." : "A private stream needs its link.";
  }
  if (!v.pageUrl) return info.pageResolves ? "Add the page the stream is on." : "Add the stream's link (.m3u8 or .mpd).";
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// What a sample found, and what is wrong.

export interface LivestreamSample {
  sampledAt: string;
  /** Seconds of stream actually read (less than asked when the stream stopped mid-sample). */
  seconds: number;
  video: { codec: string; width: number | null; height: number | null; fps: number | null } | null;
  audio: { codec: string; sampleRate: number | null; channels: string | null } | null;
  /** Integrated loudness over the sample (LUFS); -70 is the meter's floor (nothing). */
  loudnessLufs: number | null;
  /** True peak (dBFS). */
  peakDb: number | null;
  /** RMS level of each channel (dBFS), when the sound was measured. */
  channelRmsDb: number[];
  silentSec: number;
  frozenSec: number;
  blackSec: number;
  /** Bits per second the stream says it carries (from the platform, or the playlist), when known. */
  bitrate: number | null;
}

export const LIVESTREAM_PROBLEMS = ["not_live", "no_video", "no_audio", "silent", "frozen", "black", "one_channel", "unreachable"] as const;
export type LivestreamProblem = (typeof LIVESTREAM_PROBLEMS)[number];

export const LIVESTREAM_PROBLEM_LABELS: Record<LivestreamProblem, string> = {
  not_live: "not live",
  no_video: "no picture",
  no_audio: "no sound track",
  silent: "no sound",
  frozen: "picture frozen",
  black: "picture black",
  one_channel: "sound on one side only",
  unreachable: "cannot be read",
};

/** Problems worth telling someone about. `one_channel` is shown on the page only (a mono feed panned is common and harmless). */
export const LIVESTREAM_ALERT_PROBLEMS: ReadonlyArray<LivestreamProblem> = ["not_live", "no_video", "no_audio", "silent", "frozen", "black", "unreachable"];

/** Share of the sample a condition must cover to count: a pause between songs is not "no sound". */
const COVER = 0.8;

/** What is wrong with a sample (in a fixed order). Video checks only when the stream has `checkVideo` on. */
export function sampleProblems(s: LivestreamSample, opts: { silenceDb: number; checkVideo: boolean }): LivestreamProblem[] {
  const out: LivestreamProblem[] = [];
  const span = Math.max(1, s.seconds);
  if (!s.video) out.push("no_video");
  if (!s.audio) out.push("no_audio");
  if (s.audio) {
    const quiet = s.silentSec >= span * COVER || (s.loudnessLufs !== null && s.loudnessLufs <= opts.silenceDb + 3 && s.peakDb !== null && s.peakDb <= opts.silenceDb + 10);
    if (quiet) out.push("silent");
  }
  if (s.video && opts.checkVideo) {
    if (s.frozenSec >= span * COVER) out.push("frozen");
    else if (s.blackSec >= span * COVER) out.push("black");
  }
  if (s.audio && !out.includes("silent") && s.channelRmsDb.length === 2) {
    const [l, r] = s.channelRmsDb as [number, number];
    if ((l <= opts.silenceDb) !== (r <= opts.silenceDb)) out.push("one_channel");
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading ffmpeg's report (stderr). The command is `livestreamFfmpegArgs`.

function num(s: string | undefined): number | null {
  if (s === undefined) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Sum of closed spans plus an open one running to the end of the sample. */
function covered(starts: number[], durations: number[], ends: number[], total: number): number {
  let sum = durations.reduce((a, b) => a + b, 0);
  if (starts.length > ends.length) sum += Math.max(0, total - starts[starts.length - 1]!);
  return Math.min(total, sum);
}

/**
 * Turn ffmpeg's stderr into a sample. Only the INPUT stream lines describe the stream (ffmpeg also lists its own outputs).
 * Duration read comes from the last progress line (`time=`), else the number of audio samples counted, else what was asked.
 */
export function parseFfmpegAnalysis(stderr: string, askedSec: number, now: Date = new Date()): LivestreamSample {
  const lines = stderr.split(/\r\n|\r|\n/);
  let video: LivestreamSample["video"] = null;
  let audio: LivestreamSample["audio"] = null;
  let inInputs = false;
  for (const line of lines) {
    if (/^Input #\d+/.test(line)) inInputs = true;
    else if (/^(Output #\d+|Stream mapping:)/.test(line)) inInputs = false;
    if (!inInputs) continue;
    const v = /Stream #\d+:\d+.*?: Video: (\w+)/.exec(line);
    if (v && !video) {
      const size = /, (\d{2,5})x(\d{2,5})/.exec(line);
      const fps = /, ([\d.]+) fps/.exec(line);
      video = { codec: v[1]!, width: size ? Number(size[1]) : null, height: size ? Number(size[2]) : null, fps: fps ? Number(fps[1]) : null };
      continue;
    }
    const a = /Stream #\d+:\d+.*?: Audio: (\w+)/.exec(line);
    if (a && !audio) {
      const rate = /, (\d+) Hz/.exec(line);
      const layout = /, \d+ Hz, ([^,]+)/.exec(line);
      audio = { codec: a[1]!, sampleRate: rate ? Number(rate[1]) : null, channels: layout ? layout[1]!.trim() : null };
    }
  }

  const all = (re: RegExp) => [...stderr.matchAll(re)].map((m) => Number(m[1])).filter((n) => Number.isFinite(n));
  // Progress lines cover every output, and the still-frame output ends near zero, so the furthest point reached counts;
  // frames over frame rate is the second opinion (fast reads of a playlist's backlog print few progress lines).
  const times = [...stderr.matchAll(/time=(\d+):(\d+):([\d.]+)/g)].map((m) => Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
  const frames = [...stderr.matchAll(/frame=\s*(\d+)/g)].map((m) => Number(m[1]));
  let seconds = Math.max(0, ...times.filter((t) => Number.isFinite(t)));
  if (video?.fps && frames.length) seconds = Math.max(seconds, Math.max(...frames) / video.fps);
  if (seconds <= 0) seconds = askedSec;
  seconds = Math.min(askedSec, Math.round(seconds * 10) / 10);

  const silentSec = covered(all(/silence_start: (-?[\d.]+)/g), all(/silence_duration: ([\d.]+)/g), all(/silence_end: ([\d.]+)/g), seconds);
  const frozenSec = covered(all(/freeze_start: ([\d.]+)/g), all(/freeze_duration: ([\d.]+)/g), all(/freeze_end: ([\d.]+)/g), seconds);
  const blackSec = Math.min(seconds, all(/black_duration:\s*([\d.]+)/g).reduce((x, y) => x + y, 0));

  // ebur128's closing summary: "I: -16.3 LUFS" then, under "True peak:", "Peak: -1.0 dBFS".
  const summary = stderr.lastIndexOf("Summary:");
  const tail = summary >= 0 ? stderr.slice(summary) : "";
  const loud = /\bI:\s+(-?[\d.]+|-inf) LUFS/.exec(tail);
  const peak = /Peak:\s+(-?[\d.]+|-inf) dBFS/.exec(tail);
  const lufs = loud ? (loud[1] === "-inf" ? -70 : num(loud[1])) : null;
  const peakDb = peak ? (peak[1] === "-inf" ? -120 : num(peak[1])) : null;

  // astats, per channel: "Channel: 1" ... "RMS level dB: -20.1".
  const channelRmsDb: number[] = [];
  for (const block of stderr.split(/\] Channel: \d+/).slice(1)) {
    const rms = /RMS level dB: (-?[\d.]+|-inf)/.exec(block);
    if (rms) channelRmsDb.push(rms[1] === "-inf" ? -120 : Number(rms[1]));
  }

  return {
    sampledAt: now.toISOString(),
    seconds,
    video,
    audio,
    loudnessLufs: audio ? lufs : null,
    peakDb: audio ? peakDb : null,
    channelRmsDb: audio ? channelRmsDb : [],
    silentSec: audio ? Math.round(silentSec * 10) / 10 : 0,
    frozenSec: video ? Math.round(frozenSec * 10) / 10 : 0,
    blackSec: video ? Math.round(blackSec * 10) / 10 : 0,
    bitrate: null,
  };
}

const AUDIO_FILTERS = (silenceDb: number) =>
  `ebur128=peak=true:framelog=quiet,silencedetect=n=${silenceDb}dB:d=2,astats=measure_overall=none:measure_perchannel=RMS_level`;

/** What ffmpeg says when a filter names a stream the input does not have ("Stream specifier ':a:0' ... matches no streams"). */
export function ffmpegMissingStream(stderr: string): "audio" | "video" | null {
  const m = /Stream specifier '[^']*:(a|v):\d*' in filtergraph[\s\S]*?matches no streams/.exec(stderr);
  return m ? (m[1] === "a" ? "audio" : "video") : null;
}

/**
 * The ffmpeg command for one sample: read `seconds` of the video (and a separate audio stream when the platform splits
 * them), measure freeze/black/loudness/silence/per-channel level into a null output, and write one still from the middle to
 * stdout as a JPEG. Only network protocols are allowed (never `file:`), whatever the playlist names.
 */
export function livestreamFfmpegArgs(input: {
  videoUrl: string;
  audioUrl: string | null;
  headers: string | null;
  seconds: number;
  silenceDb: number;
  /** False after a first try found no sound track: ffmpeg refuses a filter whose input stream does not exist. */
  withAudio?: boolean;
}): string[] {
  const withAudio = input.withAudio !== false;
  const s = input.seconds;
  const freezeFor = Math.max(2, Math.min(4, s - 1));
  const inputArgs = (url: string) => [
    "-protocol_whitelist", "http,https,tls,tcp,crypto",
    "-rw_timeout", "15000000",
    ...(input.headers ? ["-headers", input.headers] : []),
    "-t", String(s),
    "-i", url,
  ];
  const a = input.audioUrl ? "1:a:0" : "0:a:0";
  const graph = [
    `[0:v:0]split[vm][vs]`,
    `[vm]freezedetect=n=0.003:d=${freezeFor},blackdetect=d=2:pix_th=0.1[vo]`,
    `[vs]select='gte(t\\,${(s / 2).toFixed(1)})',scale=480:-2[snap]`,
    ...(withAudio ? [`[${a}]${AUDIO_FILTERS(input.silenceDb)}[ao]`] : []),
  ].join(";");
  return [
    "-hide_banner", "-nostdin", "-loglevel", "info", "-stats_period", "1",
    ...inputArgs(input.videoUrl),
    ...(input.audioUrl && withAudio ? inputArgs(input.audioUrl) : []),
    "-filter_complex", graph,
    "-map", "[vo]", ...(withAudio ? ["-map", "[ao]"] : []), "-f", "null", "-",
    "-map", "[snap]", "-frames:v", "1", "-c:v", "mjpeg", "-q:v", "6", "-f", "image2pipe", "pipe:1",
  ];
}

/** The same for a stream without a picture (radio-style) or when a sample's video failed: sound only. */
export function livestreamFfmpegAudioArgs(input: { url: string; headers: string | null; seconds: number; silenceDb: number }): string[] {
  return [
    "-hide_banner", "-nostdin", "-loglevel", "info", "-stats_period", "1",
    "-protocol_whitelist", "http,https,tls,tcp,crypto", "-rw_timeout", "15000000",
    ...(input.headers ? ["-headers", input.headers] : []),
    "-t", String(input.seconds), "-i", input.url,
    "-af", AUDIO_FILTERS(input.silenceDb),
    "-f", "null", "-",
  ];
}

// ---------------------------------------------------------------------------------------------------------------------
// yt-dlp's answer (`yt-dlp -J <page>`): is it live, and which streams to sample.

export interface YtdlpFormat {
  format_id?: string;
  url?: string;
  protocol?: string;
  vcodec?: string | null;
  acodec?: string | null;
  height?: number | null;
  tbr?: number | null;
  abr?: number | null;
  http_headers?: Record<string, string>;
}

export interface YtdlpInfo {
  id?: string;
  title?: string;
  is_live?: boolean | null;
  live_status?: string | null;
  concurrent_view_count?: number | null;
  release_timestamp?: number | null;
  timestamp?: number | null;
  url?: string;
  formats?: YtdlpFormat[];
  http_headers?: Record<string, string>;
  _type?: string;
  entries?: YtdlpInfo[];
}

export interface PickedStreams {
  videoUrl: string;
  audioUrl: string | null;
  headers: string | null;
  bitrate: number | null;
}

const has = (c: string | null | undefined) => !!c && c !== "none";

/** Headers ffmpeg needs to send for the page's own streams (User-Agent, Referer ...), as one CRLF-joined string. */
function headerString(h: Record<string, string> | undefined): string | null {
  if (!h) return null;
  const lines = Object.entries(h)
    .filter(([k, v]) => /^[A-Za-z0-9-]+$/.test(k) && !/[\r\n]/.test(v) && !/^(cookie|authorization)$/i.test(k))
    .map(([k, v]) => `${k}: ${v}\r\n`);
  return lines.length ? lines.join("") : null;
}

/**
 * The smallest streams that still show the picture well enough to judge it: a combined stream at or under 480p if there is
 * one, else the best video at or under 480p plus the best sound. Live only: nothing for a finished video.
 */
export function pickStreams(info: YtdlpInfo, maxHeight = 480): PickedStreams | null {
  const formats = (info.formats ?? []).filter((f) => !!f.url && !/^(mhtml|storyboard)/.test(f.protocol ?? "") && !/storyboard/.test(f.format_id ?? ""));
  if (formats.length === 0) return info.url ? { videoUrl: info.url, audioUrl: null, headers: headerString(info.http_headers), bitrate: null } : null;
  const byHeight = (a: YtdlpFormat, b: YtdlpFormat) => (b.height ?? 0) - (a.height ?? 0);
  const fit = (f: YtdlpFormat) => (f.height ?? 0) <= maxHeight;
  // yt-dlp says "none" for a missing track and leaves a codec it did not learn unset (YouTube's live audio streams carry
  // `vcodec: "none"` and no `acodec` at all), so "none" is the only sure "absent".
  const combined = formats.filter((f) => has(f.vcodec) && f.acodec !== "none");
  const videoOnly = formats.filter((f) => has(f.vcodec) && f.acodec === "none");
  const audioOnly = formats.filter((f) => f.vcodec === "none" && f.acodec !== "none");
  const both = combined.filter(fit).sort(byHeight)[0] ?? null;
  if (both) return { videoUrl: both.url!, audioUrl: null, headers: headerString(both.http_headers ?? info.http_headers), bitrate: both.tbr ? Math.round(both.tbr * 1000) : null };
  const v = videoOnly.filter(fit).sort(byHeight)[0] ?? videoOnly.sort((a, b) => (a.height ?? 0) - (b.height ?? 0))[0] ?? null;
  const a = audioOnly.sort((x, y) => (y.abr ?? y.tbr ?? 0) - (x.abr ?? x.tbr ?? 0))[0] ?? null;
  if (v) return { videoUrl: v.url!, audioUrl: a?.url ?? null, headers: headerString(v.http_headers ?? info.http_headers), bitrate: v.tbr ? Math.round(v.tbr * 1000) : null };
  const any = combined.sort(byHeight).pop() ?? null;
  if (any) return { videoUrl: any.url!, audioUrl: null, headers: headerString(any.http_headers ?? info.http_headers), bitrate: null };
  return null;
}

/** What yt-dlp says about being live. A page with several entries (a channel's streams) uses the first live one. */
export function ytdlpLiveInfo(info: YtdlpInfo): { live: boolean; entry: YtdlpInfo } {
  if (info._type === "playlist" && info.entries?.length) {
    const live = info.entries.find((e) => e.is_live || e.live_status === "is_live");
    return { live: !!live, entry: live ?? info.entries[0]! };
  }
  return { live: info.is_live === true || info.live_status === "is_live", entry: info };
}

/**
 * yt-dlp's error, said for a person. "This live event will begin in 10 minutes" and "is not currently live" mean the
 * stream is simply off, not broken.
 */
export function ytdlpOffline(stderr: string): { offline: boolean; message: string } {
  const line = stderr.split(/\r?\n/).filter((l) => /ERROR:/.test(l)).pop() ?? stderr.trim().split(/\r?\n/).pop() ?? "";
  const message = line.replace(/^.*?ERROR:\s*(\[[^\]]+\]\s*)?([\w-]+:\s*)?/, "").trim().slice(0, 300) || "yt-dlp could not read the page";
  const offline = /(not currently live|will begin|is offline|premieres in|has ended|no live|not live|does not have a live|offline)/i.test(stderr);
  return { offline, message };
}

/** A direct link's playlist: live when it lists segments and is not finished (HLS), or is a dynamic manifest (DASH). */
export function manifestLiveState(text: string): { kind: "hls-master" | "hls" | "dash" | "unknown"; live: boolean; variant: string | null; bandwidth: number | null } {
  const t = text.trimStart();
  if (t.startsWith("#EXTM3U")) {
    const lines = t.split(/\r?\n/).map((l) => l.trim());
    const inf = lines.findIndex((l) => l.startsWith("#EXT-X-STREAM-INF"));
    if (inf >= 0) {
      const bw = /BANDWIDTH=(\d+)/.exec(lines[inf]!);
      const next = lines.slice(inf + 1).find((l) => l && !l.startsWith("#")) ?? null;
      return { kind: "hls-master", live: true, variant: next, bandwidth: bw ? Number(bw[1]) : null };
    }
    const segments = lines.filter((l) => l && !l.startsWith("#")).length;
    return { kind: "hls", live: segments > 0 && !lines.includes("#EXT-X-ENDLIST"), variant: null, bandwidth: null };
  }
  if (/<MPD[\s>]/.test(t)) return { kind: "dash", live: /type\s*=\s*"dynamic"/.test(t), variant: null, bandwidth: null };
  return { kind: "unknown", live: false, variant: null, bandwidth: null };
}

/** `https://www.twitch.tv/<login>` -> login, for the Twitch API. */
export function twitchLogin(pageUrl: string): string | null {
  try {
    const u = new URL(pageUrl);
    if (!/(^|\.)twitch\.tv$/i.test(u.hostname)) return null;
    const first = u.pathname.split("/").filter(Boolean)[0];
    return first && /^[a-zA-Z0-9_]{2,25}$/.test(first) ? first.toLowerCase() : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// When to tell someone.

export type LivestreamState = "live" | "offline" | "problem" | "unknown" | "outside_hours" | "disabled" | "setup";

export interface LivestreamVerdictInput {
  /** The window the stream should be live in: null = no schedule (never "not live"), else minutes since it began, or -1 = outside every window. */
  minutesIntoWindow: number | null;
  hasSchedule: boolean;
  graceMin: number;
  live: boolean | null;
  /** Consecutive status checks that found it not live (this one included). */
  offlineStreak: number;
  /** Problems of the last sample and of the one before it (the confirmation), when live. */
  lastSampleProblems: LivestreamProblem[] | null;
  previousSampleProblems: LivestreamProblem[] | null;
  unreachableStreak: number;
}

/**
 * The problems that are CONFIRMED now. A sample problem counts only when two samples in a row show it (the second is taken
 * `confirmAfterSec` after the first); "not live" only inside a scheduled window, past its grace minutes, on two checks in a
 * row; "cannot be read" after three failures in a row. Outside the schedule nothing is a problem.
 */
export function confirmedProblems(v: LivestreamVerdictInput): LivestreamProblem[] {
  if (v.hasSchedule && (v.minutesIntoWindow === null || v.minutesIntoWindow < 0)) return [];
  const out: LivestreamProblem[] = [];
  if (v.unreachableStreak >= 3) out.push("unreachable");
  if (v.live === false && v.hasSchedule && v.minutesIntoWindow !== null && v.minutesIntoWindow >= v.graceMin && v.offlineStreak >= 2) out.push("not_live");
  if (v.live && v.lastSampleProblems && v.previousSampleProblems) {
    for (const p of v.lastSampleProblems) if (v.previousSampleProblems.includes(p)) out.push(p);
  }
  return [...new Set(out)];
}

/** The marker an alert was sent for: the alert problems, sorted. "" = nothing to announce. */
export function alertMarker(problems: LivestreamProblem[]): string {
  return problems.filter((p) => LIVESTREAM_ALERT_PROBLEMS.includes(p)).sort().join(",");
}

export function describeProblems(problems: LivestreamProblem[]): string {
  return problems.map((p) => LIVESTREAM_PROBLEM_LABELS[p]).join(", ");
}

// ---------------------------------------------------------------------------------------------------------------------
// What the API returns.

export interface LivestreamEncoder {
  id: string;
  name: string;
  status: string;
  info: string;
  checkedAt: string | null;
}

export interface Livestream {
  id: string;
  name: string;
  platform: LivestreamPlatform;
  access: LivestreamAccess;
  pageUrl: string;
  hasStreamUrl: boolean;
  platformRef: string;
  statusIntervalSec: number;
  sampleIntervalSec: number;
  sampleSeconds: number;
  schedule: string;
  graceMin: number;
  silenceDb: number;
  checkVideo: boolean;
  alertGroupId: string | null;
  alertGroupName: string | null;
  encoderMonitorId: string | null;
  encoder: LivestreamEncoder | null;
  enabled: boolean;
  setupProblem: string | null;
  state: LivestreamState;
  live: boolean | null;
  liveTitle: string | null;
  liveStartedAt: string | null;
  viewers: number | null;
  /** How "live" was learned: the platform's API, the public page, or the stream link itself. */
  source: "api" | "page" | "link" | null;
  /** What the platform's API said about the encoder (Resi), for the page only. */
  platformStatus: string | null;
  statusCheckedAt: string | null;
  sampledAt: string | null;
  nextSampleAt: string | null;
  sample: LivestreamSample | null;
  sampleProblems: LivestreamProblem[];
  problems: LivestreamProblem[];
  problemSince: string | null;
  lastError: string | null;
  hasSnapshot: boolean;
  snapshotAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LivestreamCheck {
  ts: string;
  kind: "status" | "sample";
  live: boolean | null;
  viewers: number | null;
  loudnessLufs: number | null;
  peakDb: number | null;
  problems: LivestreamProblem[];
  error: string | null;
}

export interface LivestreamPlatformTest {
  ok: boolean;
  message: string;
  /** Resi: the encoders the client can see, to pick one for a stream. */
  items: Array<{ id: string; name: string; detail: string }>;
}
