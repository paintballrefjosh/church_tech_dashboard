import { createHash } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer, type Server } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { monitorScheduleActive, monitorScheduleProblem, parseMonitorSchedule, mergeMonitorSecretOptions, redactMonitorOptions } from "@church/shared";
import {
  hostPort,
  obsAuth,
  parseHlsPlaylist,
  parseHyperdeckBlock,
  parseShureBatteries,
  pjlinkAuthPrefix,
  pjlinkErrors,
  probeHls,
  probeHyperdeck,
  probePjlink,
  probeShure,
  judgeSennheiser,
  parseHttpResponse,
  judgeVmix,
  parseVmixXml,
  probeSennheiser,
  probeVmix,
  sennheiserChannelsFromSsc1,
  sscMerge,
  sscQuestions,
} from "../../../services/monitor/src/av-probes";
import { createSocket } from "node:dgram";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

const servers: Array<{ close: () => void }> = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

/** A fake device: `onLine` answers each line (split on \r\n, \r or ">") the client sends. */
async function fakeDevice(greeting: string, onLine: (line: string) => string | null): Promise<string> {
  const server: Server = createServer((sock) => {
    sock.setEncoding("utf8");
    if (greeting) sock.write(greeting);
    let buf = "";
    sock.on("data", (d: string) => {
      buf += d;
      for (;;) {
        const m = /^(.*?)(\r\n|\r|>)/s.exec(buf);
        if (!m) break;
        buf = buf.slice(m[0].length);
        const reply = onLine(m[1]! + (m[2] === ">" ? ">" : ""));
        if (reply) sock.write(reply);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return `127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("monitor schedules", () => {
  const sunMorning = parseMonitorSchedule("Sun 08:00-13:00; Wed 18:30-20:30");
  it("is active inside a window, on the site's clock", () => {
    // 2026-10-25 is a Sunday. 09:00 London = 08:00 UTC (GMT after the clocks went back that morning).
    expect(monitorScheduleActive(sunMorning, new Date("2026-10-25T09:00:00Z"), "Europe/London")).toBe(true);
    expect(monitorScheduleActive(sunMorning, new Date("2026-10-25T13:30:00Z"), "Europe/London")).toBe(false);
    expect(monitorScheduleActive(sunMorning, new Date("2026-10-28T18:45:00Z"), "Europe/London")).toBe(true);
    expect(monitorScheduleActive([], new Date(), "UTC")).toBe(true);
  });
  it("handles day ranges and windows across midnight", () => {
    const w = parseMonitorSchedule("Mon-Fri 09:00-17:00\nSat 22:00-02:00");
    expect(w[0]!.days).toEqual([1, 2, 3, 4, 5]);
    expect(monitorScheduleActive(w, new Date("2026-10-25T01:00:00Z"), "UTC")).toBe(true); // Sunday 01:00, from Saturday's window
    expect(monitorScheduleActive(w, new Date("2026-10-25T03:00:00Z"), "UTC")).toBe(false);
  });
  it("says what is wrong with one that cannot be read", () => {
    expect(monitorScheduleProblem("Sunday mornings")).toMatch(/should look like/);
    expect(monitorScheduleProblem("Sun 25:00-26:00")).toMatch(/not a time/);
    expect(monitorScheduleProblem("Xyz 08:00-09:00")).toMatch(/not a day/);
    expect(monitorScheduleProblem("")).toBeNull();
  });
});

describe("monitor option secrets", () => {
  it("are never returned and survive an edit that does not change them", () => {
    const saved = { method: "GET", authorization: "Bearer s3cret", password: "pj" };
    const shown = redactMonitorOptions(saved);
    expect(shown).toEqual({ method: "GET", authorization: "[saved]", password: "[saved]" });
    expect(mergeMonitorSecretOptions(shown, saved)).toEqual(saved);
    expect(mergeMonitorSecretOptions({ method: "GET" }, saved)).toEqual(saved); // a form that does not show them
    expect(mergeMonitorSecretOptions({ method: "GET", password: "" }, saved)).toEqual({ method: "GET", authorization: "Bearer s3cret" });
    expect(mergeMonitorSecretOptions({ authorization: "Bearer new" }, saved).authorization).toBe("Bearer new");
  });
});

describe("parsers", () => {
  it("hostPort takes a default port, and brackets for IPv6", () => {
    expect(hostPort("10.0.0.5", 9993)).toEqual({ host: "10.0.0.5", port: 9993 });
    expect(hostPort("deck.local:9000", 9993)).toEqual({ host: "deck.local", port: 9000 });
    expect(hostPort("[fd00::5]:4352", 1)).toEqual({ host: "fd00::5", port: 4352 });
  });
  it("HLS: follows a master playlist and reads the media one", () => {
    const master = parseHlsPlaylist("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow/index.m3u8\n", "https://cdn.example/live/master.m3u8");
    expect(master.variantUrl).toBe("https://cdn.example/live/low/index.m3u8");
    const media = parseHlsPlaylist(
      "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:42\n#EXT-X-PROGRAM-DATE-TIME:2026-10-25T09:00:00Z\n#EXTINF:6,\na.ts\n#EXT-X-ENDLIST\n",
      "https://x/",
    );
    expect(media).toMatchObject({ mediaSequence: 42, targetDuration: 6, segments: 1, ended: true, lastProgramDate: Date.parse("2026-10-25T09:00:00Z") });
    expect(() => parseHlsPlaylist("<html>", "https://x/")).toThrow(/not an HLS/);
  });
  it("HyperDeck blocks, PJLink auth and errors, Shure batteries", () => {
    expect(parseHyperdeckBlock("208 transport info:\r\nstatus: record\r\nspeed: 100\r\n\r\n")).toEqual({ code: 208, fields: { status: "record", speed: "100" } });
    expect(pjlinkAuthPrefix("PJLINK 1 498e4a67\r", "JBMIAProjectorLink")).toBe(createHash("md5").update("498e4a67JBMIAProjectorLink").digest("hex"));
    expect(pjlinkAuthPrefix("PJLINK 0\r", "x")).toBeNull();
    expect(pjlinkErrors("021000")).toEqual({ errors: ["lamp"], warnings: ["temperature"] });
    expect(parseShureBatteries("< REP 1 BATT_BARS 004 >< REP 2 BATT_BARS 255 >")).toEqual(new Map([[1, 4], [2, null]]));
  });
  it("OBS authentication follows the obs-websocket 5 recipe", () => {
    const secret = createHash("sha256").update("pw" + "salt").digest("base64");
    expect(obsAuth("pw", "salt", "chal")).toBe(createHash("sha256").update(secret + "chal").digest("base64"));
  });
});

describe("probes against fake devices", () => {
  it("HyperDeck: recording with space, and not recording when it should be", async () => {
    let status = "record";
    const target = await fakeDevice("500 connection info:\r\nprotocol version: 1.11\r\nmodel: HyperDeck Studio\r\n\r\n", (line) => {
      if (line === "transport info") return `208 transport info:\r\nstatus: ${status}\r\n\r\n`;
      if (line === "slot info") return "202 slot info:\r\nslot id: 1\r\nrecording time: 7200\r\n\r\n";
      return null;
    });
    expect(await probeHyperdeck({ target, options: { expectRecording: true, minRecordMinutes: 60 } })).toMatchObject({ ok: true, info: "record, 120 min of recording space" });
    expect((await probeHyperdeck({ target, options: { minRecordMinutes: 180 } })).ok).toBe(false);
    status = "stopped";
    expect(await probeHyperdeck({ target, options: { expectRecording: true } })).toMatchObject({ ok: false, info: expect.stringMatching(/^not recording/) });
  });

  it("PJLink: with a password, on, lamp hours and an error", async () => {
    const pass = "church";
    const rand = "0a1b2c3d";
    const prefix = createHash("md5").update(rand + pass).digest("hex");
    let erst = "000000";
    const target = await fakeDevice(`PJLINK 1 ${rand}\r`, (line) => {
      // A real projector answers ERRA to a command with a wrong (or missing) digest.
      const authed = line.startsWith(prefix);
      const cmd = line.slice(line.indexOf("%1"));
      if (cmd === "%1POWR ?") return authed ? "%1POWR=1\r" : "PJLINK ERRA\r";
      if (cmd === "%1ERST ?") return `%1ERST=${erst}\r`;
      if (cmd === "%1LAMP ?") return "%1LAMP=2100 1\r";
      return null;
    });
    expect(await probePjlink({ target, options: { password: pass, expectOn: true } })).toMatchObject({ ok: true, info: "on, lamp 2100 h" });
    expect((await probePjlink({ target, options: { password: pass, maxLampHours: 2000 } })).info).toMatch(/lamp due/);
    expect((await probePjlink({ target, options: { password: "wrong" } })).info).toMatch(/refused the password/);
    expect((await probePjlink({ target, options: {} })).info).toMatch(/needs a PJLink password/);
    erst = "000200";
    expect((await probePjlink({ target, options: { password: pass } })).info).toMatch(/^error: cover/);
  });

  it("Shure: a low battery is a problem, a channel with no mic is not", async () => {
    const bars: Record<string, string> = { "1": "004", "2": "255", "3": "001" };
    const target = await fakeDevice("", (line) => {
      const m = /< GET (\d) BATT_BARS >/.exec(line);
      return m ? `< REP ${m[1]} BATT_BARS ${bars[m[1]!] ?? "255"} >` : null;
    });
    expect(await probeShure({ target, options: { channels: 2 } })).toMatchObject({ ok: true, info: "ch1 4/5, ch2 no mic" });
    expect(await probeShure({ target, options: { channels: 3, minBars: 1 } })).toMatchObject({ ok: false, info: expect.stringMatching(/battery low on ch3/) });
  });

  it("an unreachable device is down with the reason", async () => {
    expect((await probeHyperdeck({ target: "127.0.0.1:9", options: { timeoutMs: 2000 } })).ok).toBe(false);
  });

  it("HLS: live, stalled and ended, from a local server", async () => {
    let seq = 1;
    let ended = false;
    const server = createHttpServer((req, res) => {
      if (req.url === "/master.m3u8") return res.end("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia.m3u8\n");
      res.end(`#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:${seq++}\n#EXTINF:1,\ns.ts\n${ended ? "#EXT-X-ENDLIST\n" : ""}`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    servers.push(server);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/master.m3u8`;
    expect(await probeHls({ target: url, options: {} })).toMatchObject({ ok: true });
    ended = true;
    expect(await probeHls({ target: url, options: {} })).toMatchObject({ ok: false, info: expect.stringMatching(/ended/) });
  }, 20_000);
});

// The example from vMix's own Developer API page (help29), plus the audio element newer versions add.
const VMIX_XML = `<vmix>
<version>27.0.0.49</version>
<edition>4K</edition>
<inputs>
<input key="26cae087" number="1" type="Capture" title="Camera 1 &amp; wide" state="Running" position="0" duration="0" muted="True" loop="False">Camera 1</input>
<input key="55cbe357" number="2" type="VirtualSet" title="LateNightNews" state="Paused" position="0" duration="0" muted="True" loop="False" selectedIndex="0">LateNightNews
<overlay index="0" key="2fe8ff9d"/>
</input>
</inputs>
<overlays><overlay number="1"/><overlay number="2">1</overlay></overlays>
<preview>2</preview>
<active>1</active>
<fadeToBlack>False</fadeToBlack>
<transitions><transition number="1" effect="Fade" duration="500"/></transitions>
<recording>False</recording>
<external>False</external>
<streaming channel1="True" channel2="False">True</streaming>
<playList>False</playList>
<multiCorder>False</multiCorder>
<audio><master volume="100" muted="False" meterF1="0.5" meterF2="0.5" headphonesVolume="74"/></audio>
</vmix>`;

describe("vMix", () => {
  it("reads its state XML", () => {
    const s = parseVmixXml(VMIX_XML);
    expect(s).toMatchObject({ version: "27.0.0.49", streaming: true, recording: false, active: 1, preview: 2, activeTitle: "Camera 1 & wide", inputs: 2, masterMuted: false, masterVolume: 100 });
    expect(judgeVmix(s, { expectStreaming: true })).toEqual({ ok: true, info: "streaming, not recording, program: Camera 1 & wide" });
    expect(judgeVmix(s, { expectRecording: true }).ok).toBe(false);
    const muted = parseVmixXml(VMIX_XML.replace('muted="False" meterF1', 'muted="True" meterF1'));
    expect(judgeVmix(muted, { expectSound: true })).toMatchObject({ ok: false, info: expect.stringMatching(/^master muted/) });
    expect(() => parseVmixXml("<html>login</html>")).toThrow(/not a vMix/);
  });

  it("asks only GET /api/, with the password when one is set", async () => {
    const seen: string[] = [];
    const server = createHttpServer((req, res) => {
      seen.push(`${req.method} ${req.url} ${req.headers.authorization ?? "-"}`);
      if (req.headers.authorization !== `Basic ${Buffer.from("ops:pw").toString("base64")}`) {
        res.statusCode = 401;
        return res.end();
      }
      res.end(VMIX_XML);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    // A target with a path or a query is cut back to host and port: nothing but the state can be asked for.
    const target = `127.0.0.1:${port}/api/?Function=StartStreaming`;
    expect(await probeVmix({ target, options: { username: "ops", password: "pw", expectStreaming: true } })).toMatchObject({ ok: true });
    expect((await probeVmix({ target, options: {} })).info).toMatch(/needs a user name/);
    expect((await probeVmix({ target, options: { username: "ops", password: "no" } })).info).toMatch(/refused/);
    expect(seen.every((l) => l.startsWith("GET /api/ "))).toBe(true);
  });
});

describe("Sennheiser EW-DX", () => {
  it("SSCv1: merges answers, ignores error replies, and judges batteries", () => {
    const tree: Record<string, unknown> = {};
    sscMerge(tree, { device: { identity: { product: "EWDX2CHS" } } });
    sscMerge(tree, { rx1: { name: "PASTOR" } });
    sscMerge(tree, { mates: { tx1: { battery: { gauge: 15 } } } });
    sscMerge(tree, { mates: { tx1: { battery: { lifetime: 95 } } } });
    sscMerge(tree, { rx2: { warnings: ["NoLink"] } });
    sscMerge(tree, { osc: { error: [{ mates: { tx2: { battery: { gauge: [424] } } } }] } });
    const chans = sennheiserChannelsFromSsc1(tree, 2);
    expect(chans[0]).toMatchObject({ n: 1, name: "PASTOR", present: true, gauge: 15, lifetimeMin: 95 });
    expect(chans[1]).toMatchObject({ n: 2, present: false });
    expect(judgeSennheiser("EWDX2CHS", chans, { minPercent: 20 })).toEqual({ ok: false, info: "battery low on ch1 PASTOR (EWDX2CHS: ch1 PASTOR 15% (1h 35m), ch2 no transmitter)" });
    expect(judgeSennheiser(null, chans, { minPercent: 10 }).ok).toBe(true);
    // Every question reads (null values only): nothing here can change the receiver.
    for (const q of sscQuestions(4)) expect(JSON.stringify(JSON.parse(q))).toMatch(/null/);
    expect(JSON.stringify(sscQuestions(4).map((q) => JSON.parse(q)))).not.toMatch(/true|false|"[A-Za-z ]+"\s*[,}]/);
  });

  it("reads a chunked HTTP answer", () => {
    const raw = Buffer.from('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n7\r\n{"gauge\r\n5\r\n":55}\r\n0\r\n\r\n');
    expect(parseHttpResponse(raw)).toEqual({ status: 200, body: '{"gauge":55}' });
    expect(() => parseHttpResponse(Buffer.from("garbage"))).toThrow();
  });

  it("SSCv1: against a fake receiver on UDP", async () => {
    const values: Record<string, unknown> = {
      "device.identity.product": "EWDX2CHS",
      "rx1.name": "LECTERN",
      "rx1.warnings": [],
      "mates.tx1.battery.gauge": 80,
      "mates.tx1.battery.lifetime": 312,
      "mates.tx1.warnings": [],
      "rx2.name": "HANDHELD",
      "rx2.warnings": ["LowSignal"],
      "mates.tx2.battery.gauge": 40,
      "mates.tx2.battery.lifetime": 120,
      "mates.tx2.warnings": ["LowBattery"],
    };
    const leaf = (o: Record<string, unknown>, path: string[] = []): string[] =>
      Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" && !Array.isArray(v) ? leaf(v as Record<string, unknown>, [...path, k]) : [[...path, k].join(".")]));
    const sock = createSocket("udp4");
    sock.on("message", (msg, rinfo) => {
      const q = JSON.parse(msg.toString()) as Record<string, unknown>;
      const [path] = leaf(q);
      const parts = path!.split(".");
      const build = (v: unknown) => parts.reduceRight<unknown>((acc, k) => ({ [k]: acc }), v);
      const reply = path! in values ? build(values[path!]) : { osc: { error: [build([424])] } };
      sock.send(JSON.stringify(reply), rinfo.port, rinfo.address);
    });
    await new Promise<void>((r) => sock.bind(0, "127.0.0.1", r));
    servers.push({ close: () => sock.close() });
    const target = `127.0.0.1:${sock.address().port}`;
    const r = await probeSennheiser({ target, options: { channels: 2 } });
    expect(r).toMatchObject({ ok: false, info: expect.stringMatching(/^battery low on ch2 HANDHELD/) });
    expect(r.info).toContain("ch1 LECTERN 80% (5h 12m)");
    expect(r.info).toContain("[LowSignal, LowBattery]");
    values["mates.tx2.warnings"] = [];
    expect((await probeSennheiser({ target, options: { channels: 2 } })).ok).toBe(true);
    expect((await probeSennheiser({ target, options: { channels: 2, failOnRf: true } })).info).toMatch(/^radio problem on ch2/);
    // A receiver with access off never answers.
    const silent = createSocket("udp4");
    await new Promise<void>((r) => silent.bind(0, "127.0.0.1", r));
    servers.push({ close: () => silent.close() });
    expect((await probeSennheiser({ target: `127.0.0.1:${silent.address().port}`, options: { timeoutMs: 500 } })).info).toMatch(/no answer on UDP 45/);
  });

  const haveOpenssl = () => {
    try {
      execFileSync("openssl", ["version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };

  it.skipIf(!haveOpenssl())("SSCv2: HTTPS with the api password, and a pinned certificate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ssc2-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "2", "-subj", "/CN=ewdx"], { stdio: "ignore" });
    const auth = `Basic ${Buffer.from("api:secret").toString("base64")}`;
    const seen: string[] = [];
    const server = createHttpsServer({ key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) }, (req, res) => {
      seen.push(`${req.method} ${req.url}`);
      const json = (status: number, body: unknown) => {
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(body === null ? "" : JSON.stringify(body));
      };
      if (req.url === "/api/device/identity") return json(200, { product: "EWDX4CHDS", serial: "1" });
      if (req.headers.authorization !== auth) return json(401, null);
      const m = /^\/api\/(channel|transmitters)\/(\d)(\/\w+)?$/.exec(req.url ?? "");
      if (!m) return json(404, null);
      const ch = Number(m[2]);
      if (m[1] === "channel" && !m[3]) return json(200, { name: `MIC ${ch + 1}`, mute: false });
      if (m[3] === "/warnings") return json(200, ch === 1 ? ["NoLink"] : []);
      if (m[3] === "/battery") return ch === 1 ? json(422, null) : json(200, { gauge: 55, lifetime: 200, type: "Battery" });
      return json(404, null);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    servers.push(server);
    const target = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    const r = await probeSennheiser({ target, options: { protocol: "ssc2", channels: 2, password: "secret" } });
    expect(r).toMatchObject({ ok: true, info: expect.stringMatching(/^EWDX4CHDS: ch1 MIC 1 55% \(3h 20m\), ch2 MIC 2 no transmitter; certificate [0-9A-F:]+$/) });
    expect(seen.every((l) => l.startsWith("GET "))).toBe(true);
    const fp = /certificate (\S+)$/.exec(r.info)![1]!;
    expect((await probeSennheiser({ target, options: { protocol: "ssc2", channels: 1, password: "secret", fingerprint: fp } })).info).not.toMatch(/certificate/);
    // A different certificate is refused before the password is sent.
    const before = seen.length;
    expect((await probeSennheiser({ target, options: { protocol: "ssc2", channels: 1, password: "secret", fingerprint: "AA:BB" } })).info).toMatch(/certificate changed/);
    expect(seen.length).toBe(before);
    expect((await probeSennheiser({ target, options: { protocol: "ssc2", channels: 1, password: "wrong" } })).info).toMatch(/refused the API password/);
  });
});
