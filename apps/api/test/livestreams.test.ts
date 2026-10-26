import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createSocket, type Socket } from "node:dgram";
import { afterEach, describe, expect, it } from "vitest";
import {
  alertMarker,
  blockedAddress,
  confirmedProblems,
  createLivestreamSchema,
  ffmpegMissingStream,
  livestreamFfmpegArgs,
  livestreamSetupProblem,
  manifestLiveState,
  monitorScheduleMinutesIn,
  parseFfmpegAnalysis,
  parseMonitorSchedule,
  pickStreams,
  sampleProblems,
  streamUrlProblem,
  twitchLogin,
  updateLivestreamSchema,
  ytdlpLiveInfo,
  ytdlpOffline,
  type LivestreamSample,
  type YtdlpInfo,
} from "@church/shared";
import { applyAtemCommands, emptyAtemState, judgeAtem, probeAtem } from "../../../services/monitor/src/av-probes";
import { looksLikeManifest } from "../src/livestreams/livestream-reader";

/**
 * Livestream checks (docs/livestreams.md). The ffmpeg reports are real: captured from ffmpeg 8.1 on a live YouTube
 * stream and on generated HLS streams (frozen and silent, no sound track, a tone on the left only), addresses replaced.
 */
const fixture = (name: string) => readFileSync(join(__dirname, "fixtures/livestreams", name), "utf8");
const opts = { silenceDb: -50, checkVideo: true };

describe("reading ffmpeg's report", () => {
  it("a healthy live YouTube stream: picture, stereo sound at a normal loudness, no problems", () => {
    const s = parseFfmpegAnalysis(fixture("ffmpeg-youtube.txt"), 10);
    expect(s.video).toMatchObject({ codec: "h264", width: 854, height: 480, fps: 30 });
    expect(s.audio).toMatchObject({ codec: "aac", sampleRate: 44100, channels: "stereo" });
    expect(s.loudnessLufs).toBeCloseTo(-11.1, 1);
    expect(s.channelRmsDb).toHaveLength(2);
    expect(s.seconds).toBeGreaterThan(5);
    expect(sampleProblems(s, opts)).toEqual([]);
  });

  it("a frozen picture with silence is both, and the measured spans cover the sample", () => {
    const s = parseFfmpegAnalysis(fixture("ffmpeg-frozen-silent.txt"), 10);
    expect(s.silentSec).toBeGreaterThanOrEqual(8);
    expect(s.frozenSec).toBeGreaterThanOrEqual(8);
    expect(sampleProblems(s, opts)).toEqual(["silent", "frozen"]);
    // With picture checks off only the sound counts.
    expect(sampleProblems(s, { ...opts, checkVideo: false })).toEqual(["silent"]);
  });

  it("a tone on one side only is one_channel (shown, never alerted)", () => {
    const s = parseFfmpegAnalysis(fixture("ffmpeg-left-only.txt"), 10);
    expect(s.channelRmsDb[0]).toBeGreaterThan(-30);
    expect(s.channelRmsDb[1]).toBe(-120);
    expect(sampleProblems(s, opts)).toEqual(["one_channel"]);
    expect(alertMarker(["one_channel"])).toBe("");
  });

  it("knows ffmpeg's 'no sound track' error, so the sample is read again without sound", () => {
    expect(ffmpegMissingStream(fixture("ffmpeg-no-audio-error.txt"))).toBe("audio");
    expect(ffmpegMissingStream(fixture("ffmpeg-youtube.txt"))).toBeNull();
    const noSound: LivestreamSample = { ...parseFfmpegAnalysis(fixture("ffmpeg-no-audio-error.txt"), 10), audio: null };
    expect(sampleProblems(noSound, opts)).toContain("no_audio");
  });

  it("builds a command that only speaks network protocols and writes one still to stdout", () => {
    const a = livestreamFfmpegArgs({ videoUrl: "https://v.example/x.m3u8", audioUrl: "https://a.example/y.m3u8", headers: "User-Agent: x\r\n", seconds: 10, silenceDb: -50 });
    expect(a[a.indexOf("-protocol_whitelist") + 1]).toBe("http,https,tls,tcp,crypto");
    expect(a.filter((x) => x === "-i")).toHaveLength(2);
    expect(a.join(" ")).toContain("[1:a:0]ebur128");
    expect(a.at(-1)).toBe("pipe:1");
    const silent = livestreamFfmpegArgs({ videoUrl: "https://v.example/x.m3u8", audioUrl: null, headers: null, seconds: 10, silenceDb: -50, withAudio: false });
    expect(silent.join(" ")).not.toContain("ebur128");
  });
});

describe("what yt-dlp found", () => {
  // The shape of `yt-dlp -J` on a YouTube live page (2026.8.19): video-only HLS formats and separate audio-only ones,
  // the audio ones with no acodec at all.
  const youtube: YtdlpInfo = {
    id: "abc123",
    title: "Sunday service",
    is_live: true,
    live_status: "is_live",
    concurrent_view_count: 42,
    formats: [
      { format_id: "sb0", url: "https://i.example/sb", protocol: "mhtml", vcodec: "none", acodec: "none" },
      { format_id: "233", url: "https://m.example/233.m3u8", protocol: "m3u8_native", vcodec: "none" },
      { format_id: "234", url: "https://m.example/234.m3u8", protocol: "m3u8_native", vcodec: "none", abr: 128 },
      { format_id: "229", url: "https://m.example/229.m3u8", protocol: "m3u8_native", vcodec: "avc1.4d4015", acodec: "none", height: 240 },
      { format_id: "231", url: "https://m.example/231.m3u8", protocol: "m3u8_native", vcodec: "avc1.4d401e", acodec: "none", height: 480, tbr: 1200, http_headers: { "User-Agent": "Mozilla/5.0", Cookie: "secret" } },
      { format_id: "232", url: "https://m.example/232.m3u8", protocol: "m3u8_native", vcodec: "avc1.4d401f", acodec: "none", height: 720 },
    ],
  };

  it("takes the 480p picture and the best sound, and never passes a cookie on", () => {
    const p = pickStreams(ytdlpLiveInfo(youtube).entry)!;
    expect(p.videoUrl).toContain("231");
    expect(p.audioUrl).toContain("234");
    expect(p.headers).toBe("User-Agent: Mozilla/5.0\r\n");
    expect(p.bitrate).toBe(1_200_000);
  });

  it("prefers a combined stream when there is one (Facebook, Vimeo, BoxCast)", () => {
    const p = pickStreams({ formats: [{ url: "https://x/hd", vcodec: "h264", acodec: "aac", height: 720 }, { url: "https://x/sd", vcodec: "h264", acodec: "aac", height: 360 }] })!;
    expect(p).toMatchObject({ videoUrl: "https://x/sd", audioUrl: null });
  });

  it("a channel page lists streams: the live one counts", () => {
    const r = ytdlpLiveInfo({ _type: "playlist", entries: [{ id: "old", is_live: false }, { id: "now", live_status: "is_live" }] });
    expect(r).toMatchObject({ live: true, entry: { id: "now" } });
  });

  it("'not live yet' is off air, a broken page is an error", () => {
    expect(ytdlpOffline("ERROR: [youtube] abc: This live event will begin in 10 minutes.").offline).toBe(true);
    expect(ytdlpOffline("ERROR: [youtube:tab] @church: The channel is not currently live").offline).toBe(true);
    const broken = ytdlpOffline("ERROR: [generic] Unable to download webpage: HTTP Error 500");
    expect(broken.offline).toBe(false);
    expect(broken.message).toContain("HTTP Error 500");
  });
});

describe("stream links", () => {
  it("reads HLS and DASH playlists", () => {
    expect(manifestLiveState("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nlow/index.m3u8\n")).toMatchObject({ kind: "hls-master", live: true, variant: "low/index.m3u8", bandwidth: 800000 });
    expect(manifestLiveState("#EXTM3U\n#EXTINF:2,\nseg1.ts\n")).toMatchObject({ kind: "hls", live: true });
    expect(manifestLiveState("#EXTM3U\n#EXTINF:2,\nseg1.ts\n#EXT-X-ENDLIST\n")).toMatchObject({ kind: "hls", live: false });
    expect(manifestLiveState('<?xml version="1.0"?><MPD type="dynamic">')).toMatchObject({ kind: "dash", live: true });
    expect(manifestLiveState("<html>")).toMatchObject({ kind: "unknown" });
    expect(looksLikeManifest("https://cdn.example/live/index.m3u8?token=1")).toBe(true);
    expect(looksLikeManifest("https://www.youtube.com/@church/live")).toBe(false);
  });

  it("refuses links the server must not fetch, and allows a LAN encoder", () => {
    expect(streamUrlProblem("file:///etc/passwd")).toMatch(/https/);
    expect(streamUrlProblem("https://user:pw@cdn.example/x.m3u8")).toMatch(/password/);
    expect(streamUrlProblem("http://169.254.169.254/latest")).toMatch(/not allowed/);
    expect(streamUrlProblem("http://localhost:3001/api")).toMatch(/not allowed/);
    expect(streamUrlProblem("http://[::ffff:127.0.0.1]/x")).toMatch(/not allowed/);
    expect(streamUrlProblem("http://192.168.20.40/live/index.m3u8")).toBeNull();
    expect(streamUrlProblem("http://meilisearch:7700/indexes")).toMatch(/full host name/);
    expect(blockedAddress("fe80::1")).toBe(true);
    expect(blockedAddress("::ffff:a9fe:a9fe")).toBe(true);
    expect(blockedAddress("10.0.0.5")).toBe(false);
  });

  it("finds the Twitch login in a channel link", () => {
    expect(twitchLogin("https://www.twitch.tv/MyChurch/videos")).toBe("mychurch");
    expect(twitchLogin("https://example.com/mychurch")).toBeNull();
  });
});

describe("a stream's settings", () => {
  it("checks the schedule and links, and keeps a saved private link unless replaced", () => {
    expect(createLivestreamSchema.safeParse({ name: "x", platform: "youtube", schedule: "Sunday at ten" }).success).toBe(false);
    expect(createLivestreamSchema.safeParse({ name: "x", platform: "resi", access: "private", streamUrl: "ftp://x" }).success).toBe(false);
    expect(updateLivestreamSchema.safeParse({ streamUrl: "[saved]" }).success).toBe(true);
    const ok = createLivestreamSchema.parse({ name: "Sunday", platform: "youtube", pageUrl: "https://www.youtube.com/@church/live", schedule: "Sun 10:15-12:15" });
    expect(ok).toMatchObject({ access: "public", statusIntervalSec: 60, sampleIntervalSec: 300, sampleSeconds: 10, enabled: true });
  });

  it("says what a stream still needs", () => {
    const base = { platform: "youtube" as const, access: "public" as const, pageUrl: "", hasStreamUrl: false, platformRef: "" };
    expect(livestreamSetupProblem(base)).toMatch(/page/);
    expect(livestreamSetupProblem({ ...base, platform: "resi" })).toMatch(/m3u8/);
    expect(livestreamSetupProblem({ ...base, access: "private" })).toMatch(/link/);
    expect(livestreamSetupProblem({ ...base, platform: "facebook", access: "private", platformRef: "12345" })).toBeNull();
    expect(livestreamSetupProblem({ ...base, pageUrl: "https://www.youtube.com/@church/live" })).toBeNull();
  });
});

describe("when to tell someone", () => {
  const base = { minutesIntoWindow: 20, hasSchedule: true, graceMin: 5, live: true, offlineStreak: 0, lastSampleProblems: [], previousSampleProblems: [], unreachableStreak: 0 };

  it("a sample problem counts only when two samples in a row show it", () => {
    expect(confirmedProblems({ ...base, lastSampleProblems: ["silent"], previousSampleProblems: null })).toEqual([]);
    expect(confirmedProblems({ ...base, lastSampleProblems: ["silent"], previousSampleProblems: ["frozen"] })).toEqual([]);
    expect(confirmedProblems({ ...base, lastSampleProblems: ["silent", "frozen"], previousSampleProblems: ["silent"] })).toEqual(["silent"]);
  });

  it("'not live' only inside the window, past the grace minutes, on two checks", () => {
    const off = { ...base, live: false, lastSampleProblems: null, previousSampleProblems: null };
    expect(confirmedProblems({ ...off, offlineStreak: 2 })).toEqual(["not_live"]);
    expect(confirmedProblems({ ...off, offlineStreak: 1 })).toEqual([]);
    expect(confirmedProblems({ ...off, offlineStreak: 5, minutesIntoWindow: 3 })).toEqual([]);
    expect(confirmedProblems({ ...off, offlineStreak: 5, minutesIntoWindow: -1 })).toEqual([]);
    // No schedule: off air is never a problem.
    expect(confirmedProblems({ ...off, offlineStreak: 9, hasSchedule: false, minutesIntoWindow: null })).toEqual([]);
  });

  it("'cannot be read' after three failures in a row", () => {
    expect(confirmedProblems({ ...base, live: null, unreachableStreak: 2 })).toEqual([]);
    expect(confirmedProblems({ ...base, live: null, unreachableStreak: 3 })).toEqual(["unreachable"]);
  });

  it("the alert marker names the alert problems in a fixed order", () => {
    expect(alertMarker(["silent", "frozen", "one_channel"])).toBe("frozen,silent");
    expect(alertMarker([])).toBe("");
  });

  it("knows how far into a window it is, also across midnight", () => {
    const w = parseMonitorSchedule("Sun 10:00-12:00; Sat 23:00-01:00");
    // 2026-10-25 is a Sunday.
    expect(monitorScheduleMinutesIn(w, new Date("2026-10-25T10:20:00Z"), "UTC")).toBe(20);
    expect(monitorScheduleMinutesIn(w, new Date("2026-10-25T00:30:00Z"), "UTC")).toBe(90);
    expect(monitorScheduleMinutesIn(w, new Date("2026-10-25T13:00:00Z"), "UTC")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// ATEM: the payload readers and the probe against a fake switcher speaking the UDP protocol.

function cmd(name: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt16BE(8 + data.length, 0);
  head.write(name, 4, "ascii");
  return Buffer.concat([head, data]);
}
const str = (s: string, len: number) => {
  const b = Buffer.alloc(len);
  b.write(s, "utf8");
  return b;
};
const u16 = (...v: number[]) => {
  const b = Buffer.alloc(v.length * 2);
  v.forEach((x, i) => b.writeUInt16BE(x, i * 2));
  return b;
};
function atemState(opts: { streaming: boolean; recording: boolean }): Buffer[] {
  const pin = Buffer.alloc(44);
  pin.write("ATEM Mini Extreme ISO", 0, "utf8");
  const inpr = Buffer.concat([u16(2), str("Pulpit camera", 20), str("CAM2", 4), Buffer.alloc(10)]);
  const srsu = Buffer.concat([str("YouTube", 64), str("rtmp://a.rtmp.youtube.com/live2", 512), str("THE-STREAM-KEY", 512)]);
  const srss = Buffer.alloc(8);
  srss.writeUInt32BE(6_000_000, 0);
  const rtms = Buffer.alloc(8);
  rtms.writeUInt16BE((opts.recording ? 1 : 0) | 2, 0);
  rtms.writeUInt32BE(5400, 4);
  return [
    Buffer.concat([cmd("_ver", Buffer.from([0, 2, 0, 30])), cmd("_pin", pin), cmd("InPr", inpr)]),
    Buffer.concat([cmd("PrgI", Buffer.concat([Buffer.from([0, 0]), u16(2)])), cmd("SRSU", srsu), cmd("SRSS", srss)]),
    Buffer.concat([cmd("StRS", u16(opts.streaming ? 4 : 1)), cmd("RTMS", rtms), cmd("InCm", Buffer.alloc(4))]),
  ];
}

describe("ATEM switcher", () => {
  it("reads product, program input, streaming and recording, and never the stream key", () => {
    const state = emptyAtemState();
    const names = new Map<number, string>();
    for (const p of atemState({ streaming: true, recording: true })) applyAtemCommands(state, p, names);
    expect(state).toMatchObject({ product: "ATEM Mini Extreme ISO", complete: true, streaming: { status: "streaming", service: "YouTube", bitrate: 6_000_000 }, recording: { recording: true, problem: null, minutesLeft: 90 } });
    expect(state.program).toEqual([{ me: 0, input: 2, name: "Pulpit camera" }]);
    expect(JSON.stringify(state)).not.toContain("STREAM-KEY");
    expect(judgeAtem(state, { expectStreaming: true, expectRecording: true })).toEqual({
      ok: true,
      info: "ATEM Mini Extreme ISO, program: Pulpit camera, streaming to YouTube at 6.0 Mb/s, recording (90 min left)",
    });
  });

  it("is down when it should be streaming and is not, and says why recording cannot run", () => {
    const state = emptyAtemState();
    const rtms = Buffer.alloc(8);
    rtms.writeUInt16BE(4, 0);
    applyAtemCommands(state, Buffer.concat([cmd("StRS", u16(1)), cmd("RTMS", rtms)]), new Map());
    expect(judgeAtem(state, { expectStreaming: true }).ok).toBe(false);
    expect(judgeAtem(state, { expectRecording: true })).toMatchObject({ ok: false, info: expect.stringContaining("disk is full") });
    expect(judgeAtem(emptyAtemState(), { expectStreaming: true }).info).toContain("no streaming on this model");
  });

  const sockets: Socket[] = [];
  afterEach(() => sockets.splice(0).forEach((s) => s.close()));

  it("the probe says hello, acknowledges each packet in order and reads the state (a fake switcher)", async () => {
    const server = createSocket("udp4");
    sockets.push(server);
    const seen: { hello: number; acks: number[]; other: number } = { hello: 0, acks: [], other: 0 };
    const session = 0x8001;
    const packet = (flags: number, id: number, payload = Buffer.alloc(0)) => {
      const h = Buffer.alloc(12);
      h.writeUInt16BE((flags << 11) | (12 + payload.length), 0);
      h.writeUInt16BE(session, 2);
      h.writeUInt16BE(id, 10);
      return Buffer.concat([h, payload]);
    };
    server.on("message", (msg, rinfo) => {
      const flags = msg.readUInt8(0) >> 3;
      if (msg.length === 20 && flags & 0x02) {
        seen.hello++;
        server.send(packet(0x02, 0), rinfo.port, rinfo.address);
        return;
      }
      if (flags & 0x10) {
        const acked = msg.readUInt16BE(4);
        seen.acks.push(acked);
        // Send the state only after the session is acknowledged, one packet per ack, as the switcher does.
        const state = atemState({ streaming: false, recording: false });
        if (acked < state.length) server.send(packet(0x01, acked + 1, state[acked]), rinfo.port, rinfo.address);
        return;
      }
      seen.other++;
    });
    await new Promise<void>((r) => server.bind(0, "127.0.0.1", () => r()));
    const port = server.address().port;
    const result = await probeAtem({ target: `127.0.0.1:${port}`, options: { timeoutMs: 3000, expectStreaming: true } });
    expect(seen.hello).toBe(1);
    // The last acknowledgement may still be on its way when the probe has what it needs and closes.
    expect(seen.acks.slice(0, 3)).toEqual([0, 1, 2]);
    expect(seen.other).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.info).toBe("ATEM Mini Extreme ISO, program: Pulpit camera, stream idle, not recording");
  });

  it("times out plainly when nothing answers", async () => {
    const r = await probeAtem({ target: "127.0.0.1:9", options: { timeoutMs: 400 } });
    expect(r.ok).toBe(false);
  });
});
