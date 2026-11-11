import { describe, expect, it } from "vitest";
import { renditionArgs, renditionBox, videoTooLarge } from "../src/signage/media-tools";

describe("signage renditions", () => {
  it("fits every video inside 1920x1080, portrait ones too (a Pi 3/4 cannot decode H.264 taller than 1088 lines)", () => {
    expect(renditionBox(1080, 1920, "video")).toEqual({ w: 1920, h: 1080 });
    expect(renditionBox(3840, 2160, "video")).toEqual({ w: 1920, h: 1080 });
    const vf = renditionArgs("video", "in", "out.mp4", 1080, 1920, false);
    expect(vf[vf.indexOf("-vf") + 1]).toContain("w='min(1920,iw)':h='min(1080,ih)'");
  });

  it("keeps a portrait picture at full height", () => {
    expect(renditionBox(1080, 1920)).toEqual({ w: 1080, h: 1920 });
    expect(renditionBox(1920, 1080)).toEqual({ w: 1920, h: 1080 });
  });

  it("finds stored videos made before the rule", () => {
    expect(videoTooLarge(1080, 1920)).toBe(true);
    expect(videoTooLarge(1920, 1080)).toBe(false);
    expect(videoTooLarge(608, 1080)).toBe(false);
    expect(videoTooLarge(null, null)).toBe(false);
  });
});
