import { describe, expect, it } from "vitest";
import { crossOriginWriteRefused, originMatchesRequest } from "@church/shared";

const h = (headers: Record<string, string>) => (name: string) => headers[name];
const site = { host: "church.example.org" };

describe("crossOriginWriteRefused", () => {
  it("never refuses a read", () => {
    expect(crossOriginWriteRefused("GET", h({ ...site, "sec-fetch-site": "cross-site", origin: "https://evil.test" }))).toBe(false);
  });
  it("lets this site's own pages write", () => {
    expect(crossOriginWriteRefused("POST", h({ ...site, "sec-fetch-site": "same-origin", origin: "https://church.example.org" }))).toBe(false);
  });
  it("lets a request without browser headers through (scripts, the web's server-side calls)", () => {
    expect(crossOriginWriteRefused("POST", h(site))).toBe(false);
  });
  it("refuses another site and a sibling subdomain (what SameSite=Lax lets through)", () => {
    expect(crossOriginWriteRefused("POST", h({ ...site, "sec-fetch-site": "cross-site", origin: "https://evil.test" }))).toBe(true);
    expect(crossOriginWriteRefused("POST", h({ ...site, "sec-fetch-site": "same-site", origin: "https://blog.example.org" }))).toBe(true);
    expect(crossOriginWriteRefused("DELETE", h({ ...site, origin: "https://blog.example.org" }))).toBe(true);
  });
  it("accepts an origin named in the APP_URL list", () => {
    expect(
      crossOriginWriteRefused("POST", h({ ...site, "sec-fetch-site": "same-site", origin: "https://admin.example.org" }), ["https://admin.example.org/"]),
    ).toBe(false);
  });
  it("judges X-Forwarded-Host as well as Host (the proxy chain may rewrite Host)", () => {
    expect(originMatchesRequest(h({ host: "web:3000", "x-forwarded-host": "church.example.org", origin: "https://church.example.org" }))).toBe(true);
  });
  it("refuses an Origin that is not a URL", () => {
    expect(crossOriginWriteRefused("POST", h({ ...site, origin: "null" }))).toBe(true);
  });
});
