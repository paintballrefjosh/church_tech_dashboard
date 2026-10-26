import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import {
  blockedAddress,
  ffmpegMissingStream,
  livestreamFfmpegArgs,
  livestreamFfmpegAudioArgs,
  manifestLiveState,
  parseFfmpegAnalysis,
  pickStreams,
  twitchLogin,
  ytdlpLiveInfo,
  ytdlpOffline,
  type LivestreamSample,
  type PickedStreams,
  type YtdlpInfo,
} from "@church/shared";

/**
 * Everything that reaches outside the API for a livestream (docs/livestreams.md): yt-dlp for a platform's page, a plain
 * fetch for a stream link, ffmpeg for a sample, and the platforms' own APIs. The decisions are pure functions in
 * `schemas/livestream.ts`; this file only runs things. The two programs get an argument array (never a shell), an
 * empty environment, a clock and a cap on what they may print.
 */

const YTDLP = process.env.YTDLP_PATH || "/opt/ytdlp/bin/yt-dlp";
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const API_TIMEOUT_MS = 10_000;
const MANIFEST_MAX_BYTES = 2 * 1024 * 1024;

export interface RunResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
}

/** Run a program with nothing from the API's environment (no secrets), killed at `timeoutMs`, output capped. */
export function runProgram(cmd: string, args: string[], opts: { timeoutMs: number; maxStdout: number }): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp", LANG: "C.UTF-8" }, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let outBytes = 0;
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      outBytes += d.length;
      if (outBytes > opts.maxStdout) child.kill("SIGKILL");
      else out.push(d);
    });
    child.stderr.on("data", (d: Buffer) => {
      // Keep the end: ffmpeg's summary (loudness, per-channel levels) is printed last.
      stderr += d.toString("utf8");
      if (stderr.length > 400_000) stderr = stderr.slice(-300_000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout: Buffer.alloc(0), stderr: String(err.message), timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out), stderr, timedOut });
    });
  });
}

export class StreamReadError extends Error {}

/** Refuse a host that resolves to loopback, link-local (cloud metadata) or "any". A private LAN address is allowed. */
export async function assertFetchableHost(url: string): Promise<void> {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  if (blockedAddress(host)) throw new StreamReadError("That address is not allowed.");
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new StreamReadError(`${host} could not be found (DNS).`);
  }
  if (addrs.some((a) => blockedAddress(a.address))) throw new StreamReadError("That address is not allowed.");
}

export interface StatusReading {
  live: boolean | null;
  viewers: number | null;
  title: string | null;
  startedAt: Date | null;
  source: "api" | "page" | "link";
  /** What to sample when it is live; null when only the platform's API could say (a private Facebook stream). */
  picked: PickedStreams | null;
  /** Set when the reading failed (live is then null). */
  error: string | null;
  /** The platform's video id when it has one (YouTube), for the API's viewer count. */
  videoId: string | null;
}

/** A link to a playlist itself (HLS or DASH), rather than a page a platform shows it on. */
export function looksLikeManifest(url: string): boolean {
  try {
    return /\.(m3u8|mpd)$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** yt-dlp on a page: is it live, and which streams carry it. "Not live yet" is an answer, not a failure. */
export async function readPage(url: string): Promise<StatusReading> {
  await assertFetchableHost(url);
  const r = await runProgram(
    YTDLP,
    ["--ignore-config", "--no-cache-dir", "--no-playlist", "--js-runtimes", "node", "--no-warnings", "--socket-timeout", "15", "-J", "--", url],
    { timeoutMs: 90_000, maxStdout: 32 * 1024 * 1024 },
  );
  const base = { viewers: null, title: null, startedAt: null, source: "page" as const, picked: null, videoId: null };
  if (r.timedOut) return { ...base, live: null, error: "Reading the page took too long." };
  if (r.code !== 0) {
    const off = ytdlpOffline(r.stderr);
    return off.offline ? { ...base, live: false, error: null } : { ...base, live: null, error: off.message };
  }
  let info: YtdlpInfo;
  try {
    info = JSON.parse(r.stdout.toString("utf8")) as YtdlpInfo;
  } catch {
    return { ...base, live: null, error: "yt-dlp gave an answer that could not be read." };
  }
  const { live, entry } = ytdlpLiveInfo(info);
  const ts = entry.release_timestamp ?? entry.timestamp ?? null;
  return {
    live,
    viewers: typeof entry.concurrent_view_count === "number" ? entry.concurrent_view_count : null,
    title: entry.title ?? null,
    startedAt: live && ts ? new Date(ts * 1000) : null,
    source: "page",
    picked: live ? pickStreams(entry) : null,
    error: null,
    videoId: entry.id ?? null,
  };
}

/** GET with a time limit, following at most three redirects, each target's host checked first. */
async function guardedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    await assertFetchableHost(current);
    const res = await fetch(current, { ...init, redirect: "manual", signal: AbortSignal.timeout(API_TIMEOUT_MS) });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(res.headers.get("location")!, current).toString();
      if (!/^https?:$/.test(new URL(current).protocol)) throw new StreamReadError("The link redirects somewhere that is not a web address.");
      continue;
    }
    return Object.assign(res, { finalUrl: current });
  }
  throw new StreamReadError("The link redirects too many times.");
}

async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new StreamReadError("The playlist is too large to be a stream's.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** A stream link (HLS or DASH): live while the playlist lists segments and is not finished. 404/410 = off. */
export async function readLink(url: string): Promise<StatusReading> {
  const base = { viewers: null, title: null, startedAt: null, source: "link" as const, picked: null, videoId: null };
  let res: Response & { finalUrl?: string };
  try {
    res = await guardedFetch(url);
  } catch (err) {
    return { ...base, live: null, error: err instanceof StreamReadError ? err.message : `The link could not be reached (${(err as Error).name === "TimeoutError" ? "no answer" : (err as Error).message}).` };
  }
  // Most streaming services answer 404 (or 410) for a stream that is not running.
  if (res.status === 404 || res.status === 410) return { ...base, live: false, error: null };
  if (!res.ok) return { ...base, live: null, error: `The link answered HTTP ${res.status}.` };
  let text: string;
  try {
    text = await readCapped(res, MANIFEST_MAX_BYTES);
  } catch (err) {
    return { ...base, live: null, error: (err as Error).message };
  }
  const state = manifestLiveState(text);
  if (state.kind === "unknown") return { ...base, live: null, error: "The link is not an HLS (.m3u8) or DASH (.mpd) playlist." };
  const finalUrl = res.finalUrl ?? url;
  // A master playlist: sample its first variant (the services list the smallest or the default first).
  const videoUrl = state.variant ? new URL(state.variant, finalUrl).toString() : finalUrl;
  return { ...base, live: state.live, picked: state.live ? { videoUrl, audioUrl: null, headers: null, bitrate: state.bandwidth } : null, error: null };
}

export interface SampleResult {
  sample: LivestreamSample | null;
  jpeg: Buffer | null;
  error: string | null;
}

/** ffmpeg on the picked streams for `seconds`; a second try without sound when the stream turned out to have none. */
export async function sampleStream(picked: PickedStreams, seconds: number, silenceDb: number): Promise<SampleResult> {
  for (const url of [picked.videoUrl, picked.audioUrl].filter((u): u is string => !!u)) {
    try {
      await assertFetchableHost(url);
    } catch (err) {
      return { sample: null, jpeg: null, error: (err as Error).message };
    }
  }
  const timeoutMs = seconds * 4_000 + 45_000;
  const opts = { timeoutMs, maxStdout: 2 * 1024 * 1024 };
  let r = await runProgram(FFMPEG, livestreamFfmpegArgs({ ...picked, seconds, silenceDb }), opts);
  if (r.code !== 0 && ffmpegMissingStream(r.stderr) === "audio") {
    r = await runProgram(FFMPEG, livestreamFfmpegArgs({ ...picked, seconds, silenceDb, withAudio: false }), opts);
  }
  if (r.timedOut) return { sample: null, jpeg: null, error: "Reading the stream took too long." };
  if (r.code !== 0) {
    if (ffmpegMissingStream(r.stderr) === "video") {
      // Sound only (a radio-style stream): measure the sound, and the sample says "no picture".
      const a = await runProgram(FFMPEG, livestreamFfmpegAudioArgs({ url: picked.audioUrl ?? picked.videoUrl, headers: picked.headers, seconds, silenceDb }), opts);
      if (a.code === 0) return { sample: { ...parseFfmpegAnalysis(a.stderr, seconds), bitrate: picked.bitrate }, jpeg: null, error: null };
    }
    const last = r.stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? "";
    // ffmpeg's last line can carry the stream's address (with its token): say only what went wrong.
    const said = last.replace(/https?:\/\/\S+/g, "<link>").slice(0, 200);
    return { sample: null, jpeg: null, error: `The stream could not be read${said ? `: ${said}` : "."}` };
  }
  const sample = parseFfmpegAnalysis(r.stderr, seconds);
  sample.bitrate = picked.bitrate;
  const jpeg = r.stdout.length > 2 && r.stdout[0] === 0xff && r.stdout[1] === 0xd8 ? r.stdout : null;
  return { sample, jpeg, error: null };
}

// ---------------------------------------------------------------------------------------------------------------------
// The platforms' APIs. Each is optional (a key in the Livestreams settings) and only adds to what the page or link says.

async function getJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: { message?: string } | string; message?: string };
      detail = typeof body.error === "string" ? body.error : (body.error?.message ?? body.message ?? "");
    } catch {
      // not JSON
    }
    throw new StreamReadError(`HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 200)}` : ""}`);
  }
  return (await res.json()) as T;
}

/** YouTube Data API: viewers and start time of a live video (one quota unit). The key travels in a header, not the URL. */
export async function youtubeDetails(apiKey: string, videoId: string): Promise<{ live: boolean; viewers: number | null; startedAt: Date | null; title: string | null }> {
  const body = await getJson<{ items?: Array<{ snippet?: { title?: string; liveBroadcastContent?: string }; liveStreamingDetails?: { concurrentViewers?: string; actualStartTime?: string } }> }>(
    `https://www.googleapis.com/youtube/v3/videos?part=snippet,liveStreamingDetails&id=${encodeURIComponent(videoId)}`,
    { headers: { "X-goog-api-key": apiKey } },
  );
  const item = body.items?.[0];
  const d = item?.liveStreamingDetails;
  return {
    live: item?.snippet?.liveBroadcastContent === "live",
    viewers: d?.concurrentViewers ? Number(d.concurrentViewers) : null,
    startedAt: d?.actualStartTime ? new Date(d.actualStartTime) : null,
    title: item?.snippet?.title ?? null,
  };
}

/** Client-credential tokens, kept until shortly before they expire (per node; a new node simply asks again). */
const tokens = new Map<string, { token: string; until: number }>();

async function clientToken(cacheKey: string, fetchToken: () => Promise<{ access_token: string; expires_in?: number }>): Promise<string> {
  const hit = tokens.get(cacheKey);
  if (hit && hit.until > Date.now()) return hit.token;
  const t = await fetchToken();
  tokens.set(cacheKey, { token: t.access_token, until: Date.now() + Math.max(60, (t.expires_in ?? 3600) - 120) * 1000 });
  return t.access_token;
}

export async function twitchStream(clientId: string, secret: string, pageUrl: string): Promise<{ live: boolean; viewers: number | null; startedAt: Date | null; title: string | null }> {
  const login = twitchLogin(pageUrl);
  if (!login) throw new StreamReadError("The page is not a Twitch channel link.");
  const token = await clientToken(`twitch:${clientId}`, () =>
    getJson<{ access_token: string; expires_in?: number }>("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: secret, grant_type: "client_credentials" }).toString(),
    }),
  );
  const body = await getJson<{ data?: Array<{ type?: string; viewer_count?: number; started_at?: string; title?: string }> }>(
    `https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(login)}`,
    { headers: { "Client-Id": clientId, Authorization: `Bearer ${token}` } },
  );
  const s = body.data?.find((x) => x.type === "live");
  return { live: !!s, viewers: s?.viewer_count ?? null, startedAt: s?.started_at ? new Date(s.started_at) : null, title: s?.title ?? null };
}

/** Facebook Graph: the page's live videos now. Private streams have no readable link, so this is all a private one gets. */
export async function facebookLive(pageToken: string, pageId: string): Promise<{ live: boolean; viewers: number | null; title: string | null }> {
  if (!/^[0-9A-Za-z._-]{1,100}$/.test(pageId)) throw new StreamReadError("The Facebook page ID is not valid.");
  const body = await getJson<{ data?: Array<{ status?: string; live_views?: number; title?: string }> }>(
    `https://graph.facebook.com/${encodeURIComponent(pageId)}/live_videos?broadcast_status=${encodeURIComponent('["LIVE"]')}&fields=id,title,status,live_views`,
    { headers: { Authorization: `Bearer ${pageToken}` } },
  );
  const v = body.data?.find((x) => x.status === "LIVE") ?? body.data?.[0];
  return { live: !!v, viewers: typeof v?.live_views === "number" ? v.live_views : null, title: v?.title ?? null };
}

const RESI = "https://api.resi.io/v1";

export interface ResiEncoder {
  id: string;
  name: string;
  /** Whatever status-like fields Resi returned, said in words (their names vary; nothing here is relied on). */
  detail: string;
}

/** Resi's encoders (read only: the dashboard never calls the Go Live routes that start or stop a stream). */
export async function resiEncoders(clientId: string, secret: string): Promise<ResiEncoder[]> {
  const token = await clientToken(`resi:${clientId}`, () =>
    getJson<{ access_token: string; expires_in?: number }>(`${RESI}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: secret, grant_type: "client_credentials" }),
    }),
  );
  const list = await getJson<Array<Record<string, unknown>>>(`${RESI}/encoders?hardwareOnly=true`, { headers: { Authorization: `Bearer ${token}` } });
  return (Array.isArray(list) ? list : []).map((e) => {
    const parts: string[] = [];
    for (const key of ["status", "state", "online", "isOnline", "streaming", "isStreaming", "connected"]) {
      const v = e[key];
      if (typeof v === "string" || typeof v === "boolean" || typeof v === "number") parts.push(`${key}: ${String(v)}`);
    }
    return { id: String(e.id ?? e.uuid ?? ""), name: String(e.name ?? e.id ?? "encoder"), detail: parts.join(", ") };
  });
}
