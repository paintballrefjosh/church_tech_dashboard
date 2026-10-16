import { describe, expect, it } from "vitest";
import { describeUserAgent } from "@church/shared";

const UA = {
  firefoxWin: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
  chromeMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  edgeWin: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
  safariIphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  chromeIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1",
  chromeAndroid: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  androidTablet: "Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  ipad: "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
};

describe("describeUserAgent", () => {
  it("names the browser and the system", () => {
    expect(describeUserAgent(UA.firefoxWin).label).toBe("Firefox on Windows");
    expect(describeUserAgent(UA.chromeMac).label).toBe("Chrome on macOS");
    expect(describeUserAgent(UA.firefoxLinux).label).toBe("Firefox on Linux");
  });

  it("does not call Edge or Chrome on iOS something else", () => {
    expect(describeUserAgent(UA.edgeWin).browser).toBe("Edge");
    expect(describeUserAgent(UA.chromeIos).browser).toBe("Chrome");
    expect(describeUserAgent(UA.chromeIos).os).toBe("iOS");
  });

  it("tells phones, tablets and desktops apart", () => {
    expect(describeUserAgent(UA.safariIphone)).toMatchObject({ browser: "Safari", os: "iOS", device: "mobile" });
    expect(describeUserAgent(UA.chromeAndroid)).toMatchObject({ os: "Android", device: "mobile" });
    expect(describeUserAgent(UA.androidTablet)).toMatchObject({ os: "Android", device: "tablet" });
    expect(describeUserAgent(UA.ipad)).toMatchObject({ os: "iPadOS", device: "tablet" });
    expect(describeUserAgent(UA.firefoxWin).device).toBe("desktop");
  });

  it("copes with nothing, and with scripts", () => {
    expect(describeUserAgent(null).label).toBe("Unknown browser");
    expect(describeUserAgent("").label).toBe("Unknown browser");
    expect(describeUserAgent("curl/8.5.0").label).toBe("curl");
    expect(describeUserAgent("node").label).toBe("node");
  });
});
