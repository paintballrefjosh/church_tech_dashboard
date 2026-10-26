import { connect as tcpConnect, isIP, type Socket } from "node:net";
import { createHash } from "node:crypto";
import { createSocket } from "node:dgram";
import { connect as tlsConnect } from "node:tls";
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

// ---------------------------------------------------------------------------------------------------------------------
// vMix (its web API, TCP 8088): `GET /api/` with no parameters returns the whole state as XML. Only that address is ever
// asked for: a `?Function=` would run a shortcut, so the URL is built here from host and port, never taken from the target.

export interface VmixState {
  version: string | null;
  edition: string | null;
  streaming: boolean;
  recording: boolean;
  external: boolean;
  multiCorder: boolean;
  fadeToBlack: boolean;
  active: number | null;
  preview: number | null;
  activeTitle: string | null;
  inputs: number;
  masterMuted: boolean | null;
  masterVolume: number | null;
}

const xmlText = (s: string): string =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

function xmlAttrs(attrs: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of attrs.matchAll(/([A-Za-z_][\w.-]*)\s*=\s*"([^"]*)"/g)) out[m[1]!] = xmlText(m[2]!);
  return out;
}

/** The parts of vMix's state XML that say whether a service is going out. Unknown elements are ignored. */
export function parseVmixXml(xml: string): VmixState {
  if (!/<vmix[\s>]/i.test(xml)) throw new Error("not a vMix API answer");
  const el = (name: string): string | null => {
    const m = new RegExp(`<${name}(?:\\s[^>]*)?>([^<]*)</${name}>`, "i").exec(xml);
    return m ? xmlText(m[1]!.trim()) : null;
  };
  const flag = (name: string) => (el(name) ?? "").toLowerCase() === "true";
  const num = (name: string) => {
    const v = el(name);
    return v !== null && /^\d+$/.test(v) ? Number(v) : null;
  };
  const titles = new Map<number, string>();
  for (const m of xml.matchAll(/<input\s([^>]*?)\/?>/gi)) {
    const a = xmlAttrs(m[1]!);
    if (a.number && /^\d+$/.test(a.number)) titles.set(Number(a.number), a.title ?? "");
  }
  const active = num("active");
  const master = /<master\s([^>]*?)\/?>/i.exec(xml);
  const ma = master ? xmlAttrs(master[1]!) : null;
  const vol = ma?.volume !== undefined ? Number(ma.volume) : NaN;
  return {
    version: el("version"),
    edition: el("edition"),
    streaming: flag("streaming"),
    recording: flag("recording"),
    external: flag("external"),
    multiCorder: flag("multiCorder"),
    fadeToBlack: flag("fadeToBlack"),
    active,
    preview: num("preview"),
    activeTitle: active !== null ? titles.get(active) ?? null : null,
    inputs: titles.size,
    masterMuted: ma?.muted !== undefined ? ma.muted.toLowerCase() === "true" : null,
    masterVolume: Number.isFinite(vol) ? vol : null,
  };
}

export function judgeVmix(
  s: VmixState,
  o: { expectStreaming?: boolean; expectRecording?: boolean; expectSound?: boolean },
): { ok: boolean; info: string } {
  const parts = [
    s.streaming ? "streaming" : "not streaming",
    s.recording ? "recording" : "not recording",
    ...(s.external ? ["external output on"] : []),
    ...(s.activeTitle ? [`program: ${s.activeTitle}`] : s.active !== null ? [`program: input ${s.active}`] : []),
    ...(s.fadeToBlack ? ["faded to black"] : []),
    ...(s.masterMuted ? ["master muted"] : []),
  ];
  const info = parts.join(", ");
  const problems: string[] = [];
  if (o.expectStreaming && !s.streaming) problems.push("not streaming");
  if (o.expectRecording && !s.recording) problems.push("not recording");
  if (o.expectSound && (s.masterMuted || s.masterVolume === 0)) problems.push(s.masterMuted ? "master muted" : "master at 0");
  return problems.length ? { ok: false, info: `${problems.join(", ")} (${info})` } : { ok: true, info };
}

/** Reachable; with `expectStreaming` / `expectRecording` / `expectSound` (master not muted and not at 0) as asked. */
export async function probeVmix(ctx: ProbeContext): Promise<ProbeResult> {
  const o = ctx.options as { timeoutMs?: number; username?: string; password?: string; expectStreaming?: boolean; expectRecording?: boolean; expectSound?: boolean };
  const { host, port } = hostPort(ctx.target, 8088);
  const start = Date.now();
  try {
    const headers: Record<string, string> = {};
    if (o.password) headers.authorization = `Basic ${Buffer.from(`${o.username ?? ""}:${o.password}`).toString("base64")}`;
    const res = await fetch(`http://${host.includes(":") ? `[${host}]` : host}:${port}/api/`, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(o.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - start;
    if (res.status === 401) return { ok: false, latencyMs, info: o.password ? "vMix refused the user name or password" : "vMix needs a user name and password (Settings, Web Controller)" };
    if (!res.ok) return { ok: false, latencyMs, info: `HTTP ${res.status}` };
    const text = await res.text();
    return { latencyMs, ...judgeVmix(parseVmixXml(text.slice(0, 5_000_000)), o) };
  } catch (err) {
    return failure(start, err);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Sennheiser EW-DX receivers (EM 2, EM 2 Dante, EM 4 Dante): transmitter battery and channel warnings.
// Two protocols, chosen in the options: SSCv1 ("ssc1", JSON over UDP 45, no password; firmware before 4.0, or 4.x with
// third-party access set to "legacy") and SSCv2 ("ssc2", HTTPS REST with user `api` and the password set when the receiver
// was claimed; firmware 4.0+ with third-party access "secure"). Only reads: every SSCv1 message asks with `null` values,
// every SSCv2 request is a GET.

export interface SennheiserChannel {
  n: number; // 1-based, as printed on the receiver
  name: string | null;
  present: boolean; // a transmitter is linked and reports its battery
  gauge: number | null; // percent
  lifetimeMin: number | null;
  rxWarnings: string[];
  txWarnings: string[];
}

type Tree = Record<string, unknown>;
const isTree = (v: unknown): v is Tree => typeof v === "object" && v !== null && !Array.isArray(v);

/** Deep-merges one SSCv1 reply into what was gathered. Error replies (`{"osc":{"error":...}}`) are left out. */
export function sscMerge(into: Tree, reply: unknown): void {
  if (!isTree(reply)) return;
  for (const [k, v] of Object.entries(reply)) {
    if (k === "osc") continue;
    if (isTree(v) && isTree(into[k])) sscMerge(into[k] as Tree, v);
    else if (isTree(v)) {
      const t: Tree = {};
      sscMerge(t, v);
      into[k] = t;
    } else into[k] = v;
  }
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The SSCv1 address tree (`rx1`, `mates.tx1` ...) as channels. */
export function sennheiserChannelsFromSsc1(tree: Tree, channels: number): SennheiserChannel[] {
  const out: SennheiserChannel[] = [];
  const mates = isTree(tree.mates) ? tree.mates : {};
  for (let n = 1; n <= channels; n++) {
    const rx = isTree(tree[`rx${n}`]) ? (tree[`rx${n}`] as Tree) : {};
    const tx = isTree(mates[`tx${n}`]) ? (mates[`tx${n}`] as Tree) : {};
    const bat = isTree(tx.battery) ? tx.battery : {};
    const gauge = numOrNull(bat.gauge);
    const lifetimeMin = numOrNull(bat.lifetime);
    out.push({
      n,
      name: typeof rx.name === "string" && rx.name ? rx.name : null,
      present: gauge !== null || lifetimeMin !== null,
      gauge,
      lifetimeMin,
      rxWarnings: strings(rx.warnings),
      txWarnings: strings(tx.warnings),
    });
  }
  return out;
}

/** The SSCv1 questions: one address per message, so a missing transmitter (error 424) costs only its own answer. */
export function sscQuestions(channels: number): string[] {
  const q: unknown[] = [{ device: { identity: { product: null } } }];
  for (let n = 1; n <= channels; n++) {
    q.push({ [`rx${n}`]: { name: null } }, { [`rx${n}`]: { warnings: null } });
    q.push({ mates: { [`tx${n}`]: { battery: { gauge: null } } } }, { mates: { [`tx${n}`]: { battery: { lifetime: null } } } });
    q.push({ mates: { [`tx${n}`]: { warnings: null } } });
  }
  return q.map((x) => JSON.stringify(x));
}

const RF_PROBLEM_WARNINGS = new Set(["LowSignal", "Aes256Error"]);

export function judgeSennheiser(
  product: string | null,
  chans: SennheiserChannel[],
  o: { minPercent?: number; failOnRf?: boolean },
): { ok: boolean; info: string } {
  const min = o.minPercent ?? 20;
  const low: string[] = [];
  const rf: string[] = [];
  const parts = chans.map((c) => {
    const label = `ch${c.n}${c.name ? ` ${c.name}` : ""}`;
    const warn = [...c.rxWarnings.filter((w) => w !== "NoLink"), ...c.txWarnings];
    if (!c.present) return `${label} no transmitter`;
    if ((c.gauge !== null && c.gauge <= min) || c.txWarnings.includes("LowBattery")) low.push(label);
    if (c.rxWarnings.some((w) => RF_PROBLEM_WARNINGS.has(w))) rf.push(label);
    const time = c.lifetimeMin !== null ? ` (${Math.floor(c.lifetimeMin / 60)}h ${c.lifetimeMin % 60}m)` : "";
    return `${label} ${c.gauge !== null ? `${c.gauge}%` : "battery ?"}${time}${warn.length ? ` [${warn.join(", ")}]` : ""}`;
  });
  const info = `${product ? `${product}: ` : ""}${parts.join(", ")}`;
  if (low.length) return { ok: false, info: `battery low on ${low.join(", ")} (${info})` };
  if (o.failOnRf && rf.length) return { ok: false, info: `radio problem on ${rf.join(", ")} (${info})` };
  return { ok: true, info };
}

async function sennheiserSsc1(host: string, port: number, channels: number, timeoutMs: number): Promise<{ product: string | null; chans: SennheiserChannel[] }> {
  const questions = sscQuestions(channels);
  const tree: Tree = {};
  const socket = createSocket(host.includes(":") ? "udp6" : "udp4");
  let answers = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => (answers > 0 ? resolve() : reject(new Error("no answer on UDP 45: is third-party access on, set to legacy (SSCv1)? Firmware 4.0+ defaults to off; choose SSCv2 for secure"))), timeoutMs);
      socket.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      socket.on("message", (msg) => {
        answers++;
        try {
          sscMerge(tree, JSON.parse(msg.toString("utf8")));
        } catch {
          /* not JSON: ignored */
        }
        if (answers >= questions.length) {
          clearTimeout(timer);
          resolve();
        }
      });
      // A small gap between datagrams: a receiver drops a burst it cannot buffer.
      void (async () => {
        for (const q of questions) {
          socket.send(q, port, host);
          await new Promise((r) => setTimeout(r, 15));
        }
      })();
    });
  } finally {
    socket.close();
  }
  const device = isTree(tree.device) ? tree.device : {};
  const identity = isTree(device.identity) ? device.identity : {};
  return { product: typeof identity.product === "string" ? identity.product : null, chans: sennheiserChannelsFromSsc1(tree, channels) };
}

/** Reads a whole HTTP/1.1 response (Connection: close): status and body, chunked or not. Exported for the tests. */
export function parseHttpResponse(raw: Buffer): { status: number; body: string } {
  const end = raw.indexOf("\r\n\r\n");
  if (end < 0) throw new Error("the receiver sent no complete answer");
  const head = raw.subarray(0, end).toString("latin1").split("\r\n");
  const m = /^HTTP\/1\.[01] (\d{3})/.exec(head[0] ?? "");
  if (!m) throw new Error("not an HTTP answer");
  const chunked = head.some((h) => /^transfer-encoding:\s*chunked/i.test(h));
  let body = raw.subarray(end + 4);
  if (chunked) {
    const parts: Buffer[] = [];
    let at = 0;
    for (;;) {
      const nl = body.indexOf("\r\n", at);
      if (nl < 0) break;
      const size = parseInt(body.subarray(at, nl).toString("latin1"), 16);
      if (!Number.isFinite(size) || size <= 0) break;
      parts.push(body.subarray(nl + 2, nl + 2 + size));
      at = nl + 2 + size + 2;
    }
    body = Buffer.concat(parts);
  }
  return { status: Number(m[1]), body: body.toString("utf8") };
}

/**
 * One HTTPS GET to the receiver. The certificate is the receiver's own (self-signed), so the chain is not judged; when
 * `fingerprint` is set it must match, and that is checked when the handshake ends, BEFORE the request (with the password)
 * is written. A plain https.request writes its headers as soon as it can, so it is not used here.
 */
function sscv2Get(
  host: string,
  port: number,
  path: string,
  password: string | null,
  fingerprint: string | null,
  timeoutMs: number,
): Promise<{ status: number; body: unknown; seen: string | null }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let seen: string | null = null;
    const sock = tlsConnect({ host, port, rejectUnauthorized: false, servername: isIP(host) ? undefined : host });
    const timer = setTimeout(() => sock.destroy(new Error("timeout")), timeoutMs);
    sock.once("secureConnect", () => {
      seen = sock.getPeerCertificate()?.fingerprint256 ?? null;
      const norm = (f: string) => f.replace(/[^0-9a-f]/gi, "").toLowerCase();
      if (fingerprint && (!seen || norm(seen) !== norm(fingerprint))) {
        return sock.destroy(new Error(`the receiver's certificate changed (now ${seen ?? "none"}); check it and update the fingerprint`));
      }
      const auth = password ? `Authorization: Basic ${Buffer.from(`api:${password}`).toString("base64")}\r\n` : "";
      sock.write(`GET ${path} HTTP/1.1\r\nHost: ${host.includes(":") ? `[${host}]` : host}\r\nAccept: application/json\r\n${auth}Connection: close\r\n\r\n`);
    });
    sock.on("data", (d: Buffer) => {
      size += d.length;
      if (size > 1_000_000) return sock.destroy(new Error("answer too large"));
      chunks.push(d);
    });
    sock.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    sock.once("end", () => {
      clearTimeout(timer);
      try {
        const r = parseHttpResponse(Buffer.concat(chunks));
        let body: unknown = null;
        try {
          body = r.body ? JSON.parse(r.body) : null;
        } catch {
          body = null;
        }
        resolve({ status: r.status, body, seen });
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function sennheiserSsc2(
  host: string,
  port: number,
  channels: number,
  password: string | null,
  fingerprint: string | null,
  timeoutMs: number,
): Promise<{ product: string | null; chans: SennheiserChannel[]; seen: string | null }> {
  // A fingerprint must be checked before the password is sent, so the identity (no sign-in needed) goes first.
  const id = await sscv2Get(host, port, "/api/device/identity", null, fingerprint, timeoutMs);
  if (!password) throw new Error("SSCv2 needs the receiver's API password (set when it was claimed)");
  const product = isTree(id.body) && typeof id.body.product === "string" ? id.body.product : null;
  const chans: SennheiserChannel[] = [];
  for (let i = 0; i < channels; i++) {
    const [ch, warn, bat] = await Promise.all([
      sscv2Get(host, port, `/api/channel/${i}`, password, fingerprint, timeoutMs),
      sscv2Get(host, port, `/api/channel/${i}/warnings`, password, fingerprint, timeoutMs),
      sscv2Get(host, port, `/api/transmitters/${i}/battery`, password, fingerprint, timeoutMs),
    ]);
    if ([ch, warn, bat].some((r) => r.status === 401 || r.status === 403)) throw new Error("the receiver refused the API password");
    if (ch.status === 404 && i > 0) break; // fewer channels than asked for
    const b = bat.status === 200 && isTree(bat.body) ? bat.body : {};
    const gauge = numOrNull(b.gauge);
    const lifetimeMin = numOrNull(b.lifetime);
    const name = isTree(ch.body) && typeof ch.body.name === "string" && ch.body.name ? ch.body.name : null;
    const w = warn.status === 200 ? (Array.isArray(warn.body) ? strings(warn.body) : isTree(warn.body) ? strings(warn.body.warnings) : []) : [];
    chans.push({ n: i + 1, name, present: gauge !== null || lifetimeMin !== null, gauge, lifetimeMin, rxWarnings: w, txWarnings: strings(b.warnings) });
  }
  return { product, chans, seen: id.seen };
}

/** Reachable; a linked transmitter at `minPercent` or less (default 20) or reporting LowBattery is a problem. */
export async function probeSennheiser(ctx: ProbeContext): Promise<ProbeResult> {
  const o = ctx.options as { timeoutMs?: number; protocol?: string; channels?: number; minPercent?: number; failOnRf?: boolean; password?: string; fingerprint?: string };
  const channels = Math.max(1, Math.min(4, o.channels ?? 2));
  const ssc2 = o.protocol === "ssc2";
  const { host, port } = hostPort(ctx.target, ssc2 ? 443 : 45);
  const timeoutMs = o.timeoutMs ?? (ssc2 ? DEFAULT_TIMEOUT_MS : 4000);
  const start = Date.now();
  try {
    if (ssc2) {
      const r = await sennheiserSsc2(host, port, channels, o.password || null, o.fingerprint?.trim() || null, timeoutMs);
      const j = judgeSennheiser(r.product, r.chans, o);
      return { latencyMs: Date.now() - start, ok: j.ok, info: !o.fingerprint && r.seen ? `${j.info}; certificate ${r.seen}` : j.info };
    }
    const r = await sennheiserSsc1(host, port, channels, timeoutMs);
    return { latencyMs: Date.now() - start, ...judgeSennheiser(r.product, r.chans, o) };
  } catch (err) {
    return failure(start, err);
  }
}
