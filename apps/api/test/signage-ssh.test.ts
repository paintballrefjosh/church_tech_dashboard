import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { utils } from "ssh2";
import { describe, expect, it } from "vitest";
import { compareVersions, packDir, versionInBundle } from "../src/signage/agent-bundle";
import { BadGatewayException, BadRequestException, ConflictException } from "@nestjs/common";
import { bigDigits, isDesktopImage, shellQuote, showCodeProblem } from "../src/signage/discovery.service";
import { PiSshError, parseSshConnection } from "../src/signage/pi-ssh";
import { deriveSignageKey } from "../src/signage/ssh-key";
import { signageClearCodeSchema } from "@lampstand/shared";

describe("the signage SSH key", () => {
  it("is the same for the same secret and generation, and different otherwise", () => {
    const a = deriveSignageKey("secret-one", 1);
    expect(deriveSignageKey("secret-one", 1)).toEqual(a);
    expect(deriveSignageKey("secret-one", 2).publicKey).not.toBe(a.publicKey);
    expect(deriveSignageKey("secret-two", 1).publicKey).not.toBe(a.publicKey);
    expect(a.publicKey).toMatch(/^ssh-ed25519 AAAA[A-Za-z0-9+/=]+ lampstand-signage-g1$/);
  });

  it("refuses no secret and a generation below 1", () => {
    expect(() => deriveSignageKey("", 1)).toThrow();
    expect(() => deriveSignageKey("s", 0)).toThrow();
  });

  it("is a private key ssh2 reads, whose public half and fingerprint match", () => {
    const k = deriveSignageKey("secret-one", 3);
    const parsed = utils.parseKey(k.privateKey);
    expect(parsed instanceof Error).toBe(false);
    const key = Array.isArray(parsed) ? parsed[0]! : (parsed as Exclude<typeof parsed, Error | unknown[]>);
    const blob = key.getPublicSSH();
    expect(`ssh-ed25519 ${blob.toString("base64")}`).toBe(k.publicKey.split(" ").slice(0, 2).join(" "));
    expect(k.fingerprint).toBe(`SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`);
    // A signature made with it verifies with the public half.
    const sig = key.sign(Buffer.from("hello"));
    expect(key.verify(Buffer.from("hello"), sig)).toBe(true);
  });
});

describe("the agent bundle", () => {
  function folder(): string {
    const d = mkdtempSync(join(tmpdir(), "agent-"));
    mkdirSync(join(d, "bin"));
    mkdirSync(join(d, "tests"));
    mkdirSync(join(d, "signage_agent", "__pycache__"), { recursive: true });
    writeFileSync(join(d, "VERSION"), "1.2.3\n");
    writeFileSync(join(d, "bin", "signage-ctl"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(d, "signage_agent", "x.py"), "print(1)\n");
    writeFileSync(join(d, "signage_agent", "__pycache__", "x.cpython-313.pyc"), "junk");
    writeFileSync(join(d, "tests", "test_x.py"), "assert True\n");
    return d;
  }

  it("packs the same bytes every time, whatever the file times, and leaves out tests and caches", () => {
    const d = folder();
    const a = packDir(d);
    execFileSync("touch", ["-d", "2001-01-01", join(d, "VERSION")]);
    expect(packDir(d).equals(a)).toBe(true);
    expect(versionInBundle(a)).toBe("1.2.3");
    const out = join(d, "..", `${d.split("/").pop()}.tgz`);
    writeFileSync(out, a);
    const listed = spawnSync("tar", ["tzvf", out], { encoding: "utf8" });
    expect(listed.status).toBe(0);
    expect(listed.stdout).toContain("bin/signage-ctl");
    expect(listed.stdout).toMatch(/rwxr-xr-x.*bin\/signage-ctl/);
    expect(listed.stdout).not.toContain("tests/");
    expect(listed.stdout).not.toContain("__pycache__");
  });

  it("a bundle without VERSION names no version", () => {
    const d = mkdtempSync(join(tmpdir(), "agent-"));
    writeFileSync(join(d, "README.md"), "x");
    expect(versionInBundle(packDir(d))).toBeNull();
  });

  it("compares versions by number", () => {
    expect(compareVersions("1.10.0", "1.2.10")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0")).toBe(0);
    expect(compareVersions("0.9.9", "1.0.0")).toBeLessThan(0);
  });
});

describe("small helpers", () => {
  it("reads the dashboard's address from SSH_CONNECTION", () => {
    expect(parseSshConnection("192.168.96.3 51234 192.168.96.12 22\n")).toBe("192.168.96.3");
    expect(parseSshConnection("")).toBeNull();
    expect(parseSshConnection("fe80::1 1 fe80::2 22")).toBeNull();
  });

  it("quotes for sh so a value stays one word", () => {
    const out = execFileSync("sh", ["-c", `printf '%s|' ${shellQuote("it's $HOME; rm -rf /")}`], { encoding: "utf8" });
    expect(out).toBe("it's $HOME; rm -rf /|");
  });

  it("draws a code as ten rows of block letters", () => {
    const rows = bigDigits("418");
    expect(rows).toHaveLength(10);
    expect(new Set(rows.map((r) => r.length)).size).toBe(1);
    expect(rows[0]).toContain("##");
  });
});

describe("Show a code failures", () => {
  it("a refused login is a readable 400 that names the user tried, not a 500", () => {
    const e = showCodeProblem(new PiSshError("The Pi refused the login (wrong user name, password or key).", "auth"), "pi");
    expect(e).toBeInstanceOf(BadRequestException);
    expect(e.message).toContain('"pi"');
    expect(e.message).toContain("Signage > Security settings");
  });
  it("a changed host key is a 409 and an unreachable Pi a 502, with the Pi's own words", () => {
    expect(showCodeProblem(new PiSshError("key changed", "host_key"), "pi")).toBeInstanceOf(ConflictException);
    const down = showCodeProblem(new PiSshError("The Pi does not answer.", "unreachable"), "pi");
    expect(down).toBeInstanceOf(BadGatewayException);
    expect(down.message).toBe("The Pi does not answer.");
  });
  it("tells a desktop Pi from Lite by how it boots", () => {
    expect(isDesktopImage("graphical.target inactive\n")).toBe(true);
    expect(isDesktopImage("multi-user.target active\n")).toBe(true);
    expect(isDesktopImage("multi-user.target inactive\n")).toBe(false);
    expect(isDesktopImage("multi-user.target \n")).toBe(false);
    expect(isDesktopImage("")).toBe(false);
  });
  it("anything else passes through unchanged", () => {
    const other = new Error("boom");
    expect(showCodeProblem(other, "pi")).toBe(other);
  });
});

describe("taking a code off a Pi's screen", () => {
  it("takes the login, and the console to go back to", () => {
    expect(signageClearCodeSchema.parse({})).toEqual({});
    expect(signageClearCodeSchema.parse({ username: "pi", password: "x", vt: 7 })).toEqual({ username: "pi", password: "x", vt: 7 });
  });
  it("refuses a console number that could be anything else, and unknown fields", () => {
    expect(() => signageClearCodeSchema.parse({ vt: 0 })).toThrow();
    expect(() => signageClearCodeSchema.parse({ vt: 64 })).toThrow();
    expect(() => signageClearCodeSchema.parse({ vt: "7; reboot" })).toThrow();
    expect(() => signageClearCodeSchema.parse({ command: "x" })).toThrow();
  });
});
