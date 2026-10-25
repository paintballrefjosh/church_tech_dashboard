import { headers } from "next/headers";
import QRCode from "qrcode";

/**
 * This site's origin as the person's browser reached it (Caddy's X-Forwarded-Host/Proto), for links printed on paper. The
 * app bakes no host name in (CLAUDE.md "Public origin"), so a sign printed from the LAN address carries that address.
 */
export async function publicOrigin(): Promise<string> {
  const h = await headers();
  const proto = (h.get("x-forwarded-proto") ?? "http").split(",")[0]?.trim() || "http";
  const host = (h.get("x-forwarded-host") ?? h.get("host") ?? "").split(",")[0]?.trim() ?? "";
  return host ? `${proto}://${host}` : "";
}

/** A QR code for `url` as an SVG string (made here from our own URL, so it is safe to inline). */
export function qrSvg(url: string): Promise<string> {
  return QRCode.toString(url, { type: "svg", margin: 0, errorCorrectionLevel: "M" });
}
