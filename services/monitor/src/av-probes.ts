import { connect as tcpConnect, type Socket } from "node:net";
import { createHash } from "node:crypto";
import { createSocket } from "node:dgram";
import type { ProbeContext, ProbeResult } from "./probes";

/**
 * Probes for church AV equipment and livestreams. Each speaks the device's own plain network protocol, read-only:
 * nothing here changes a setting, starts or stops anything. The parsing is in pure functions (exported for
 * apps/api/test/av-probes.test.ts, which also runs each probe against a fake device).
 */

const DEFAULT_TIMEOUT_MS = 10_000;

/** host[:port] with a default port. IPv6 literals go in brackets. */
export function hostPort(target: string, defaultPort: number): { host: string; port: number } {
  const t = target.trim().replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "");
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(t);
  if (v6) return { host: v6[1]!, port: v6[2] ? Number(v6[2]) : defaultPort };
  const m = /^([^:]+)(?::(\d+))?$/.exec(t);
  if (!m) return { host: t, port: defaultPort };
  return { host: m[1]!, port: m[2] ? Number(m[2]) : defaultPort };
}

/**
 * A short conversation over TCP: connect, let `talk` send and wait for text, close. `until(buffer)` resolves once the
 * accumulated text satisfies it. Everything is bounded by one timeout.
 */
async function tcpTalk<T>(
  host: string,
  port: number,
  timeoutMs: number,
  talk: (io: { send: (s: string) => void; until: (pred: (buf: string) => boolean) => Promise<string> }) => Promise<T>,
): Promise<T> {
  const socket: Socket = tcpConnect({ host, port });
  socket.setEncoding("utf8");
  let buf = "";
  let failed: Error | null = null;
  const waiters: Array<() => void> = [];
  const wake = () => waiters.splice(0).forEach((w) => w());
  socket.on("data", (d: string) => {
    buf += d;
    if (buf.length > 1_000_000) buf = buf.slice(-100_000);
    wake();
  });
  socket.on("error", (e) => {
    failed = e;
    wake();
  });
  socket.on("close", () => {
    failed ??= new Error("the device closed the connection");
    wake();
  });
  const timer = setTimeout(() => {
    failed ??= new Error("timeout");
    socket.destroy();
    wake();
  }, timeoutMs);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    const until = async (pred: (b: string) => boolean): Promise<string> => {
      for (;;) {
        if (pred(buf)) {
          const out = buf;
          buf = "";
          return out;
        }
        if (failed) throw failed;
        await new Promise<void>((r) => waiters.push(r));
      }
    };
    return await talk({ send: (s) => socket.write(s), until });
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
}

function failure(start: number, err: unknown): ProbeResult {
  const e = err as { code?: string; message?: string };
  return { ok: false, latencyMs: Date.now() - start, info: e.code ?? e.message ?? "error" };
}

// ---------------------------------------------------------------------------------------------------------------------
// HLS livestream: the playlist loads and is moving.

export interface HlsMedia {
  variantUrl: string | null; // a master playlist names its streams; the first is followed
  ended: boolean;
  mediaSequence: number;
  targetDuration: number;
  segments: number;
  /** EXT-X-PROGRAM-DATE-TIME of the last segment (epoch ms), when the stream writes it. */
  lastProgramDate: number | null;
}

export function parseHlsPlaylist(text: string, baseUrl: string): HlsMedia {
  if (!text.trimStart().startsWith("#EXTM3U")) throw new Error("not an HLS playlist (#EXTM3U missing)");
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  let variantUrl: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.startsWith("#EXT-X-STREAM-INF")) {
      const next = lines.slice(i + 1).find((l) => l && !l.startsWith("#"));
      if (next) variantUrl = new URL(next, baseUrl).toString();
      break;
    }
  }
  const num = (tag: string): number => {
    const l = lines.find((x) => x.startsWith(`${tag}:`));
    return l ? Number(l.slice(tag.length + 1)) : 0;
  };
  let lastProgramDate: number | null = null;
  let pending: number | null = null;
  let segments = 0;
  for (const l of lines) {
    if (l.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
      const t = Date.parse(l.slice("#EXT-X-PROGRAM-DATE-TIME:".length));
      pending = Number.isNaN(t) ? null : t;
    } else if (l.startsWith("#EXTINF")) {
      segments++;
      if (pending !== null) lastProgramDate = pending;
      pending = null;
    }
  }
  return {
    variantUrl,
    ended: lines.includes("#EXT-X-ENDLIST"),
    mediaSequence: num("#EXT-X-MEDIA-SEQUENCE"),
    targetDuration: num("#EXT-X-TARGETDURATION"),
    segments,
    lastProgramDate,
  };
}

async function getText(url: string, timeoutMs: number): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/**
 * Live if the media playlist is not ended and is moving: its last segment's program date is recent (`maxAgeSec`, default
 * 60), or, when the stream writes none, the media sequence advances between two reads one target duration apart.
 */
export async function probeHls(ctx: ProbeContext): Promise<ProbeResult> {
  const o = ctx.options as { timeoutMs?: number; maxAgeSec?: number };
  const timeoutMs = o.timeoutMs ?? 20_000;
  const start = Date.now();
  try {
    let url = ctx.target;
    let media = parseHlsPlaylist(await getText(url, timeoutMs), url);
    if (media.variantUrl) {
      url = media.variantUrl;
      media = parseHlsPlaylist(await getText(url, timeoutMs), url);
    }
    const latencyMs = Date.now() - start;
    if (media.ended) return { ok: false, latencyMs, info: "the stream has ended (#EXT-X-ENDLIST)" };
    if (media.segments === 0) return { ok: false, latencyMs, info: "the playlist has no segments" };
    if (media.lastProgramDate !== null) {
      const age = Math.round((Date.now() - media.lastProgramDate) / 1000);
      const max = o.maxAgeSec ?? 60;
      return age <= max ? { ok: true, latencyMs, info: `live, last segment ${age}s ago` } : { ok: false, latencyMs, info: `stalled: last segment ${age}s ago` };
    }
    const waitMs = Math.min(Math.max(media.targetDuration, 2) + 1, 12) * 1000;
    await new Promise((r) => setTimeout(r, waitMs));
    const again = parseHlsPlaylist(await getText(url, timeoutMs), url);
    if (again.ended) return { ok: false, latencyMs, info: "the stream has ended (#EXT-X-ENDLIST)" };
    return again.mediaSequence > media.mediaSequence
      ? { ok: true, latencyMs, info: `live, sequence ${again.mediaSequence}` }
      : { ok: false, latencyMs, info: `stalled: sequence stuck at ${again.mediaSequence}` };
  } catch (err) {
    return failure(start, err);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Blackmagic HyperDeck (Ethernet protocol, TCP 9993).

/** The `key: value` lines of one HyperDeck reply block ("208 transport info:" ... blank line). */
export function parseHyperdeckBlock(text: string): { code: number; fields: Record<string, string> } {
  const lines = text.split(/\r?\n/);
  const code = Number(/^(\d{3})/.exec(lines[0] ?? "")?.[1] ?? 0);
  const fields: Record<string, string> = {};
  for (const l of lines.slice(1)) {
    const i = l.indexOf(":");
    if (i > 0) fields[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
  }
  return { code, fields };
}

const blockDone = (marker: RegExp) => (b: string) => marker.test(b) && /\r?\n\r?\n$/.test(b);

/**
 * Reachable, and (with `expectRecording`) recording; with `minRecordMinutes`, the recording space left on the active slot
 * must last at least that long.
 */
export async function probeHyperdeck(ctx: ProbeContext): Promise<ProbeResult> {
  const o = ctx.options as { timeoutMs?: number; expectRecording?: boolean; minRecordMinutes?: number };
  const { host, port } = hostPort(ctx.target, 9993);
  const start = Date.now();
  try {
    const { transport, slot } = await tcpTalk(host, port, o.timeoutMs ?? DEFAULT_TIMEOUT_MS, async (io) => {
      await io.until(blockDone(/^500 connection info/m));
      io.send("transport info\r\n");
      const transport = parseHyperdeckBlock(await io.until(blockDone(/^208 transport info/m)));
      io.send("slot info\r\n");
      const slot = parseHyperdeckBlock(await io.until(blockDone(/^(202 slot info|1\d\d )/m)));
      return { transport, slot };
    });
    const latencyMs = Date.now() - start;
    const status = transport.fields.status ?? "unknown";
    const minutesLeft = slot.fields["recording time"] ? Math.floor(Number(slot.fields["recording time"]) / 60) : null;
    const info = `${status}${minutesLeft !== null ? `, ${minutesLeft} min of recording space` : ""}`;
    if (o.expectRecording && status !== "record") return { ok: false, latencyMs, info: `not recording (${info})` };
    if (o.minRecordMinutes && minutesLeft !== null && minutesLeft < o.minRecordMinutes) {
      return { ok: false, latencyMs, info: `recording space low: ${info}` };
    }
    return { ok: true, latencyMs, info };
  } catch (err) {
    return failure(start, err);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Projectors and displays: PJLink class 1 (TCP 4352).

/** The prefix PJLink authentication puts before the first command: MD5 of the projector's random number + password. */
export function pjlinkAuthPrefix(greeting: string, password: string): string | null {
  const m = /^PJLINK 1 ([0-9a-fA-F]+)/.exec(greeting.trim());
  if (!m) return null;
  return createHash("md5").update(m[1]! + password).digest("hex");
}

export const PJLINK_POWER: Record<string, string> = { "0": "off", "1": "on", "2": "cooling down", "3": "warming up" };
const PJLINK_ERRORS = ["fan", "lamp", "temperature", "cover", "filter", "other"];

/** The parts of ERST that are in error ("2") or warning ("1"). */
export function pjlinkErrors(erst: string): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  [...erst.slice(0, 6)].forEach((c, i) => {
    if (c === "2") errors.push(PJLINK_ERRORS[i]!);
    else if (c === "1") warnings.push(PJLINK_ERRORS[i]!);
  });
  return { errors, warnings };
}

/** Reachable, no error status; with `expectOn` powered on; with `maxLampHours` the first lamp below it. */
export async function probePjlink(ctx: ProbeContext): Promise<ProbeResult> {
  const o = ctx.options as { timeoutMs?: number; password?: string; expectOn?: boolean; maxLampHours?: number };
  const { host, port } = hostPort(ctx.target, 4352);
  const start = Date.now();
  try {
    const answers = await tcpTalk(host, port, o.timeoutMs ?? DEFAULT_TIMEOUT_MS, async (io) => {
      const greeting = await io.until((b) => /\r/.test(b));
      if (/^PJLINK ERRA/.test(greeting)) throw new Error("the projector refused the password");
      let prefix = "";
      if (/^PJLINK 1 /.test(greeting)) {
        if (!o.password) throw new Error("the projector needs a PJLink password");
        prefix = pjlinkAuthPrefix(greeting, o.password)!;
      }
      const ask = async (cmd: string): Promise<string> => {
        io.send(`${prefix}%1${cmd} ?\r`);
        prefix = "";
        const line = (await io.until((b) => /\r/.test(b))).trim();
        if (/^PJLINK ERRA/.test(line)) throw new Error("the projector refused the password");
        return line.replace(new RegExp(`^%1${cmd}=`), "");
      };
      return { powr: await ask("POWR"), erst: await ask("ERST"), lamp: await ask("LAMP") };
    });
    const latencyMs = Date.now() - start;
    const power = PJLINK_POWER[answers.powr] ?? `power ${answers.powr}`;
    const lampHours = /^\d+/.test(answers.lamp) ? Number(answers.lamp.split(/\s+/)[0]) : null;
    const { errors, warnings } = /^\d{6}$/.test(answers.erst) ? pjlinkErrors(answers.erst) : { errors: [], warnings: [] };
    const info = [power, lampHours !== null ? `lamp ${lampHours} h` : null, warnings.length ? `warning: ${warnings.join(", ")}` : null]
      .filter(Boolean)
      .join(", ");
    if (errors.length) return { ok: false, latencyMs, info: `error: ${errors.join(", ")} (${info})` };
    if (o.expectOn && answers.powr !== "1") return { ok: false, latencyMs, info: `not on (${info})` };
    if (o.maxLampHours && lampHours !== null && lampHours >= o.maxLampHours) return { ok: false, latencyMs, info: `lamp due for replacement (${info})` };
    return { ok: true, latencyMs, info };
  } catch (err) {
    return failure(start, err);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Shure wireless receivers (ULX-D, SLX-D, QLX-D, Axient: command strings over TCP 2202).

/** `< REP <ch> BATT_BARS <nnn> >` replies, by channel. 255 = no transmitter / not known. */
export function parseShureBatteries(text: string): Map<number, number | null> {
  const out = new Map<number, number | null>();
  for (const m of text.matchAll(/<\s*REP\s+(\d+)\s+BATT_BARS\s+(\d+)\s*>/g)) {
    const v = Number(m[2]);
    out.set(Number(m[1]), v === 255 ? null : v);
  }
  return out;
}

/** Reachable; any channel with a transmitter at `minBars` bars or fewer (default 1 of 5) is a problem. */
export async function probeShure(ctx: ProbeContext): Promise<ProbeResult> {
  const o = ctx.options as { timeoutMs?: number; channels?: number; minBars?: number };
  const channels = Math.max(1, Math.min(8, o.channels ?? 4));
  const { host, port } = hostPort(ctx.target, 2202);
  const start = Date.now();
  try {
    const text = await tcpTalk(host, port, o.timeoutMs ?? DEFAULT_TIMEOUT_MS, async (io) => {
      for (let ch = 1; ch <= channels; ch++) io.send(`< GET ${ch} BATT_BARS >`);
      return io.until((b) => parseShureBatteries(b).size >= channels);
    });
    const latencyMs = Date.now() - start;
    const bars = parseShureBatteries(text);
    const min = o.minBars ?? 1;
    const low: string[] = [];
    const parts: string[] = [];
    for (const [ch, v] of [...bars.entries()].sort((a, b) => a[0] - b[0])) {
      parts.push(`ch${ch} ${v === null ? "no mic" : `${v}/5`}`);
      if (v !== null && v <= min) low.push(`ch${ch}`);
    }
    const info = parts.join(", ");
    return low.length ? { ok: false, latencyMs, info: `battery low on ${low.join(", ")} (${info})` } : { ok: true, latencyMs, info };
  } catch (err) {
    return failure(start, err);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// OBS Studio (obs-websocket 5, built into OBS 28+, port 4455).

/** obs-websocket 5 authentication: base64(sha256(base64(sha256(password + salt)) + challenge)). */
export function obsAuth(password: string, salt: string, challenge: string): string {
  const secret = createHash("sha256").update(password + salt).digest("base64");
  return createHash("sha256").update(secret + challenge).digest("base64");
}

interface ObsMessage {
  op: number;
  d: Record<string, unknown>;
}

/** Reachable; with `expectStreaming` / `expectRecording`, that output must be active. */
export async function probeObs(ctx: ProbeContext): Promise<ProbeResult> {
  const o = ctx.options as { timeoutMs?: number; password?: string; expectStreaming?: boolean; expectRecording?: boolean };
  const { host, port } = hostPort(ctx.target, 4455);
  const start = Date.now();
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `ws://${host.includes(":") ? `[${host}]` : host}:${port}`;
  let ws: WebSocket | null = null;
  try {
    const state = await new Promise<{ streaming: boolean; recording: boolean }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      ws = new WebSocket(url, "obswebsocket.json");
      const socket = ws;
      const got: { streaming?: boolean; recording?: boolean } = {};
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error("could not connect to OBS"));
      };
      socket.onclose = (e) => {
        clearTimeout(timer);
        reject(new Error(e.code === 4009 ? "OBS refused the password" : `OBS closed the connection (${e.code})`));
      };
      socket.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data)) as ObsMessage;
        if (msg.op === 0) {
          const auth = msg.d.authentication as { challenge: string; salt: string } | undefined;
          if (auth && !o.password) {
            clearTimeout(timer);
            return reject(new Error("OBS needs a password"));
          }
          socket.send(JSON.stringify({ op: 1, d: { rpcVersion: 1, ...(auth ? { authentication: obsAuth(o.password!, auth.salt, auth.challenge) } : {}) } }));
        } else if (msg.op === 2) {
          socket.send(JSON.stringify({ op: 6, d: { requestType: "GetStreamStatus", requestId: "stream" } }));
          socket.send(JSON.stringify({ op: 6, d: { requestType: "GetRecordStatus", requestId: "record" } }));
        } else if (msg.op === 7) {
          const data = (msg.d.responseData ?? {}) as { outputActive?: boolean };
          if (msg.d.requestId === "stream") got.streaming = !!data.outputActive;
          if (msg.d.requestId === "record") got.recording = !!data.outputActive;
          if (got.streaming !== undefined && got.recording !== undefined) {
            clearTimeout(timer);
            resolve({ streaming: got.streaming, recording: got.recording });
          }
        }
      };
    });
    const latencyMs = Date.now() - start;
    const info = `${state.streaming ? "streaming" : "not streaming"}, ${state.recording ? "recording" : "not recording"}`;
    if (o.expectStreaming && !state.streaming) return { ok: false, latencyMs, info };
    if (o.expectRecording && !state.recording) return { ok: false, latencyMs, info };
    return { ok: true, latencyMs, info };
  } catch (err) {
    return failure(start, err);
  } finally {
    try {
      (ws as WebSocket | null)?.close();
    } catch {
      /* already closed */
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Blackmagic ATEM switcher (UDP 9910): the switcher sends its whole state when a client says hello; we read it and leave.
// Read-only: the only packets sent are the hello and the acknowledgements the protocol needs. The streaming key that
// arrives with the state (SRSU) is never read.

export const ATEM_PORT = 9910;
const ATEM_HELLO = Buffer.from([0x10, 0x14, 0x53, 0xab, 0, 0, 0, 0, 0, 0x3a, 0, 0, 0x01, 0, 0, 0, 0, 0, 0, 0]);
const ATEM_FLAG = { ackRequest: 0x01, newSession: 0x02, ackReply: 0x10 } as const;
const ATEM_STREAM = { idle: 1, connecting: 2, streaming: 4, stopping: 32 } as const;

export interface AtemState {
  product: string | null;
  /** Program input per mix/effect bus (ME 1 = index 0), with its long name when known. */
  program: Array<{ me: number; input: number; name: string | null }>;
  /** Null when the switcher has no streaming (only the Mini Pro / Extreme / Constellation ones do). */
  streaming: { status: "idle" | "connecting" | "streaming" | "stopping" | "error"; service: string | null; bitrate: number | null } | null;
  recording: { recording: boolean; problem: string | null; minutesLeft: number | null } | null;
  complete: boolean;
}

export function emptyAtemState(): AtemState {
  return { product: null, program: [], streaming: null, recording: null, complete: false };
}

const cstr = (b: Buffer) => {
  const z = b.indexOf(0);
  return (z >= 0 ? b.subarray(0, z) : b).toString("utf8").trim();
};

/** Fold the commands of one packet's payload (after the 12-byte header) into the state. Pure; unit-tested. */
export function applyAtemCommands(state: AtemState, payload: Buffer, inputNames: Map<number, string>): void {
  let off = 0;
  while (off + 8 <= payload.length) {
    const len = payload.readUInt16BE(off);
    if (len < 8 || off + len > payload.length) break;
    const name = payload.toString("ascii", off + 4, off + 8);
    const d = payload.subarray(off + 8, off + len);
    off += len;
    switch (name) {
      case "_pin":
        if (d.length >= 1) state.product = cstr(d.subarray(0, Math.min(40, d.length))) || null;
        break;
      case "InPr":
        if (d.length >= 22) inputNames.set(d.readUInt16BE(0), cstr(d.subarray(2, 22)));
        break;
      case "PrgI":
        if (d.length >= 4) {
          const me = d.readUInt8(0);
          state.program = state.program.filter((p) => p.me !== me).concat({ me, input: d.readUInt16BE(2), name: null });
        }
        break;
      case "StRS":
        if (d.length >= 2) {
          const v = d.readUInt16BE(0);
          const err = v & (16 | 32768);
          const s = v & ~(16 | 32768);
          const status = err ? "error" : s === ATEM_STREAM.streaming ? "streaming" : s === ATEM_STREAM.connecting ? "connecting" : s === ATEM_STREAM.stopping ? "stopping" : "idle";
          state.streaming = { service: state.streaming?.service ?? null, bitrate: state.streaming?.bitrate ?? null, status };
        }
        break;
      case "SRSS":
        if (d.length >= 4) state.streaming = { status: state.streaming?.status ?? "idle", service: state.streaming?.service ?? null, bitrate: d.readUInt32BE(0) };
        break;
      case "SRSU":
        // Service name only (bytes 0-64). The URL and the stream KEY follow it and are deliberately not read.
        if (d.length >= 1) state.streaming = { status: state.streaming?.status ?? "idle", bitrate: state.streaming?.bitrate ?? null, service: cstr(d.subarray(0, Math.min(64, d.length))) || null };
        break;
      case "RTMS":
        if (d.length >= 2) {
          const v = d.readUInt16BE(0);
          const recording = (v & 1) === 1;
          const e = v & ~(1 | 128);
          const problem = e & 32768 ? "unknown recording error" : e & 4 ? "the recording disk is full" : e & 8 ? "recording disk error" : e & 16 ? "the recording disk is not formatted" : e & 32 ? "dropping frames" : (e & 2) === 0 ? "no recording disk" : null;
          const left = d.length >= 8 ? d.readUInt32BE(4) : null;
          state.recording = { recording, problem, minutesLeft: left === null ? null : Math.floor(left / 60) };
        }
        break;
      case "InCm":
        state.complete = true;
        break;
      default:
        break;
    }
  }
  for (const p of state.program) p.name = inputNames.get(p.input) ?? null;
}

/** What one ATEM reading says, and whether it is a problem. Pure; unit-tested. */
export function judgeAtem(state: AtemState, o: { expectStreaming?: boolean; expectRecording?: boolean }): { ok: boolean; info: string } {
  const parts: string[] = [];
  if (state.product) parts.push(state.product);
  const pgm = state.program.sort((a, b) => a.me - b.me)[0];
  if (pgm) parts.push(`program: ${pgm.name || `input ${pgm.input}`}`);
  let ok = true;
  if (state.streaming) {
    const s = state.streaming;
    const rate = s.bitrate ? ` at ${(s.bitrate / 1_000_000).toFixed(1)} Mb/s` : "";
    parts.push(s.status === "streaming" ? `streaming${s.service ? ` to ${s.service}` : ""}${rate}` : s.status === "error" ? "stream error" : `stream ${s.status}`);
    if (o.expectStreaming && s.status !== "streaming") ok = false;
  } else if (o.expectStreaming) {
    parts.push("no streaming on this model");
    ok = false;
  }
  if (state.recording) {
    const r = state.recording;
    parts.push(r.recording ? `recording${r.minutesLeft !== null ? ` (${r.minutesLeft} min left)` : ""}` : "not recording");
    if (r.problem) parts.push(r.problem);
    if (o.expectRecording && (!r.recording || (r.problem && r.problem !== "dropping frames"))) ok = false;
  } else if (o.expectRecording) {
    parts.push("no recording on this model");
    ok = false;
  }
  return { ok, info: parts.join(", ") || "answered" };
}

export async function probeAtem(ctx: ProbeContext): Promise<ProbeResult> {
  const o = ctx.options as { timeoutMs?: number; expectStreaming?: boolean; expectRecording?: boolean };
  const { host, port } = hostPort(ctx.target, ATEM_PORT);
  const start = Date.now();
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const socket = createSocket(host.includes(":") ? "udp6" : "udp4");
  const state = emptyAtemState();
  const names = new Map<number, string>();
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(state.product ? "the switcher stopped sending its state" : "timeout (no answer on UDP 9910)")), timeoutMs);
      let session = 0;
      let lastId = -1;
      const ack = (id: number) => {
        const b = Buffer.alloc(12);
        b.writeUInt16BE((ATEM_FLAG.ackReply << 11) | 12, 0);
        b.writeUInt16BE(session, 2);
        b.writeUInt16BE(id, 4);
        socket.send(b, port, host);
      };
      socket.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      socket.on("message", (msg: Buffer) => {
        if (msg.length < 12) return;
        const flags = msg.readUInt8(0) >> 3;
        const length = msg.readUInt16BE(0) & 0x07ff;
        session = msg.readUInt16BE(2);
        const id = msg.readUInt16BE(10);
        if (flags & ATEM_FLAG.newSession) {
          lastId = id;
          ack(id);
          return;
        }
        if (flags & ATEM_FLAG.ackRequest) {
          if (lastId < 0 || id === (lastId + 1) % 32768) {
            lastId = id;
            ack(id);
            if (length > 12) applyAtemCommands(state, msg.subarray(12, Math.min(length, msg.length)), names);
            if (state.complete) {
              clearTimeout(timer);
              resolve();
            }
          } else {
            ack(lastId);
          }
        }
      });
      socket.send(ATEM_HELLO, port, host);
    });
    const verdict = judgeAtem(state, o);
    return { ok: verdict.ok, latencyMs: Date.now() - start, info: verdict.info };
  } catch (err) {
    return failure(start, err);
  } finally {
    socket.close();
  }
}
