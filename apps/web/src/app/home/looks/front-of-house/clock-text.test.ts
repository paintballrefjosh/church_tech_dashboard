import { describe, expect, it } from "vitest";
import { countdownLeft } from "../../parts/countdown";
import { clockText } from "./clock-text";

const now = new Date("2026-11-06T17:00:00Z");
const after = (ms: number) => clockText(countdownLeft(new Date(now.getTime() + ms), now));
const H = 3_600_000;
const M = 60_000;

describe("clockText", () => {
  it("shows days, hours and minutes a day or more out, never more than 23 hours", () => {
    expect(after(64 * H + 4 * M + 12_000)).toBe("2d 16h 04m");
    expect(after(24 * H)).toBe("1d 0h 00m");
  });

  it("is a stage clock inside the last day", () => {
    expect(after(24 * H - 1000)).toBe("23:59:59");
    expect(after(3 * H + 5 * M + 9000)).toBe("03:05:09");
    expect(after(42_000)).toBe("00:00:42");
  });

  it("stops at zero once the service has started", () => {
    expect(after(-5 * M)).toBe("00:00:00");
  });
});
