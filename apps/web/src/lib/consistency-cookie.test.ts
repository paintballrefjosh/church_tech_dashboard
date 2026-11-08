import { describe, expect, it } from "vitest";
import { parseConsistencySetCookie } from "./consistency-cookie";

describe("parseConsistencySetCookie", () => {
  it("reads the value and lifetime of the API's cookie", () => {
    expect(parseConsistencySetCookie("lampstand_rv=1760000000000; Path=/; Max-Age=10; HttpOnly; SameSite=Lax")).toEqual({
      value: "1760000000000",
      maxAge: 10,
    });
  });

  it("ignores every other cookie, including a lookalike name", () => {
    expect(parseConsistencySetCookie("authjs.session-token=abc; Path=/")).toBeNull();
    expect(parseConsistencySetCookie("xlampstand_rv=1760000000000; Path=/")).toBeNull();
  });

  it("refuses a value that is not a time (nothing else may ride on this cookie)", () => {
    expect(parseConsistencySetCookie("lampstand_rv=abc; Path=/")).toBeNull();
    expect(parseConsistencySetCookie("lampstand_rv=1; evil; Path=/")).toEqual({ value: "1", maxAge: 10 });
    expect(parseConsistencySetCookie("lampstand_rv=")).toBeNull();
  });
});
