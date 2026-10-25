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
} from "../../../services/monitor/src/av-probes";

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
