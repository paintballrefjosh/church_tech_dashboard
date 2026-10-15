import { describe, expect, it } from "vitest";
import { sessionIsCurrent, sessionVersionOf } from "../src/auth/session-version";
import { handshakeOriginAllowed } from "../src/realtime/realtime.gateway";

describe("session version", () => {
  it("treats a cookie from before the claim existed as version 0", () => {
    expect(sessionVersionOf({})).toBe(0);
    expect(sessionVersionOf(null)).toBe(0);
    expect(sessionIsCurrent({}, { sessionVersion: 0 })).toBe(true);
  });
  it("accepts a cookie only while its version matches the account's", () => {
    expect(sessionIsCurrent({ sv: 3 }, { sessionVersion: 3 })).toBe(true);
    expect(sessionIsCurrent({ sv: 3 }, { sessionVersion: 4 })).toBe(false);
    expect(sessionIsCurrent({}, { sessionVersion: 1 })).toBe(false);
  });
  it("ignores a malformed claim rather than trusting it", () => {
    for (const sv of ["3", -1, 1.5, NaN, null, {}]) expect(sessionVersionOf({ sv })).toBe(0);
  });
});

describe("WebSocket handshake origin", () => {
  const allowed = (h: Record<string, string>) => handshakeOriginAllowed(h);
  it("lets a handshake without Origin through (a script, not a browser)", () => {
    expect(allowed({ host: "dash.church.org" })).toBe(true);
  });
  it("lets this site's own origin through, by Host or X-Forwarded-Host", () => {
    expect(allowed({ origin: "https://dash.church.org", host: "dash.church.org" })).toBe(true);
    expect(allowed({ origin: "https://dash.church.org", host: "api:3001", "x-forwarded-host": "dash.church.org" })).toBe(true);
    expect(allowed({ origin: "http://localhost:8100", host: "localhost:8100" })).toBe(true);
  });
  it("refuses another origin, including a sibling subdomain", () => {
    expect(allowed({ origin: "https://evil.example", host: "dash.church.org" })).toBe(false);
    expect(allowed({ origin: "https://blog.church.org", host: "dash.church.org" })).toBe(false);
    expect(allowed({ origin: "not a url", host: "dash.church.org" })).toBe(false);
  });
  it("honours the APP_URL allowlist", () => {
    const before = process.env.APP_URL;
    process.env.APP_URL = "https://other.church.org/";
    try {
      expect(allowed({ origin: "https://other.church.org", host: "dash.church.org" })).toBe(true);
    } finally {
      if (before === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = before;
    }
  });
});
