import { describe, expect, it } from "vitest";
import { sessionIdOf, sessionIsCurrent, sessionVersionOf } from "../src/auth/session-version";
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

describe("one browser session", () => {
  const A = "0b0e2c1e-8c3a-4f0e-9d57-3f1b6f6f4a11";
  const B = "7d9a1f3c-2e44-4b8e-a0aa-5c1d2e3f4a55";
  it("reads a well-formed session id and nothing else", () => {
    expect(sessionIdOf({ sid: A })).toBe(A);
    expect(sessionIdOf({ sid: A.toUpperCase() })).toBe(A);
    for (const sid of ["", "abc", `${A}x`, 5, null, {}, "'; drop table user_sessions;--"]) expect(sessionIdOf({ sid })).toBeNull();
    expect(sessionIdOf(null)).toBeNull();
  });
  it("refuses a cookie whose session was ended, and only that one", () => {
    const user = { sessionVersion: 0, revokedSessions: [A] };
    expect(sessionIsCurrent({ sid: A }, user)).toBe(false);
    expect(sessionIsCurrent({ sid: A.toUpperCase() }, user)).toBe(false);
    expect(sessionIsCurrent({ sid: B }, user)).toBe(true);
  });
  it("lets a cookie without an id through (it ends with the version instead)", () => {
    expect(sessionIsCurrent({}, { sessionVersion: 0, revokedSessions: [A] })).toBe(true);
    expect(sessionIsCurrent({ sv: 0, sid: B }, { sessionVersion: 1, revokedSessions: [] })).toBe(false);
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
