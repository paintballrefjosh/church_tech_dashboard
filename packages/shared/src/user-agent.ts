/**
 * A short, human description of a browser's User-Agent header for the "your sessions" list ("Firefox on Windows").
 * Deliberately small: it recognises the browsers and systems a church is likely to have and says "Unknown browser" for
 * the rest, instead of pulling in a parsing library. Order matters: Edge, Opera and Chrome on iOS all carry "Chrome"
 * or "Safari" in their string too.
 */
export interface UserAgentInfo {
  browser: string;
  os: string;
  device: "desktop" | "mobile" | "tablet" | "unknown";
  label: string;
}

const BROWSERS: Array<[RegExp, string]> = [
  [/\b(?:Edg|EdgA|EdgiOS|Edge)\//, "Edge"],
  [/\b(?:OPR|Opera)\//, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/\bCriOS\/|\bChrome\//, "Chrome"],
  [/\bSafari\//, "Safari"],
];

export function describeUserAgent(raw: string | null | undefined): UserAgentInfo {
  const ua = (raw ?? "").slice(0, 400);
  if (!ua) return { browser: "Unknown browser", os: "unknown system", device: "unknown", label: "Unknown browser" };

  let browser = "Unknown browser";
  for (const [re, name] of BROWSERS) {
    if (re.test(ua)) {
      browser = name;
      break;
    }
  }

  let os = "unknown system";
  let device: UserAgentInfo["device"] = "desktop";
  if (/\biPad\b/.test(ua)) {
    os = "iPadOS";
    device = "tablet";
  } else if (/\b(?:iPhone|iPod)\b/.test(ua)) {
    os = "iOS";
    device = "mobile";
  } else if (/\bAndroid\b/.test(ua)) {
    os = "Android";
    device = /\bMobile\b/.test(ua) ? "mobile" : "tablet";
  } else if (/\bWindows\b/.test(ua)) os = "Windows";
  else if (/\bCrOS\b/.test(ua)) os = "ChromeOS";
  else if (/\bMac OS X\b|\bMacintosh\b/.test(ua)) os = "macOS";
  else if (/\bLinux\b|\bX11\b/.test(ua)) os = "Linux";
  else device = "unknown";

  // A script's agent string ("node", "curl/8", "python-requests") is not a browser.
  if (browser === "Unknown browser" && os === "unknown system") {
    return { browser, os, device: "unknown", label: ua.split(/[\s/]/)[0] || "Unknown browser" };
  }
  return { browser, os, device, label: os === "unknown system" ? browser : `${browser} on ${os}` };
}
