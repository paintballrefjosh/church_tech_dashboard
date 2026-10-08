import { describe, expect, it } from "vitest";
import { configChecksum, normalizeConfig } from "../src/cisco/config-normalize";

const BASE = [
  "Building configuration...",
  "!Time: Thu Oct  8 06:24:00 2026",
  "ssh idle-timeout 0 keepalive-count 0",
  "",
  "ip domain-lookup",
  "radius-server timeout 5 ",
  "hostname House-Server-SW01",
].join("\n");

describe("normalizeConfig", () => {
  it("ignores blank lines that come and go between captures", () => {
    const withBlank = BASE.replace("ip domain-lookup\n", "ip domain-lookup\n\n");
    const without = BASE.replace("keepalive-count 0\n\n", "keepalive-count 0\n");
    expect(configChecksum(normalizeConfig(withBlank))).toBe(configChecksum(normalizeConfig(without)));
    expect(configChecksum(normalizeConfig(withBlank))).toBe(configChecksum(normalizeConfig(BASE)));
  });

  it("ignores trailing whitespace and CRLF line endings", () => {
    expect(normalizeConfig(BASE.replace(/\n/g, "\r\n"))).toBe(normalizeConfig(BASE));
  });

  it("drops volatile header lines and comments", () => {
    expect(normalizeConfig(BASE)).toBe(
      ["ssh idle-timeout 0 keepalive-count 0", "ip domain-lookup", "radius-server timeout 5", "hostname House-Server-SW01"].join("\n"),
    );
  });

  it("still sees a real change", () => {
    expect(configChecksum(normalizeConfig(BASE.replace("timeout 5", "timeout 6")))).not.toBe(
      configChecksum(normalizeConfig(BASE)),
    );
  });
});
