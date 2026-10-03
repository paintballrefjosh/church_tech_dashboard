import { NotFoundException } from "@nestjs/common";
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Shared-secret gate for endpoints that are `@Public()` because they're called
 * by the web service before any user session exists (provider config bootstrap,
 * OAuth user provisioning). The caller must present a header value derived
 * from AUTH_SECRET — already available in both containers via env_file.
 *
 * We hash rather than send AUTH_SECRET directly so it never appears on the wire
 * or in logs. The Caddyfile also 404s these paths on the public proxy, so an
 * external attacker has to defeat both layers.
 *
 * Throws NotFoundException (not 401) so an external probe can't distinguish
 * "endpoint exists but token is wrong" from "endpoint doesn't exist" — matches
 * the Caddy-level 404 response.
 */
export function assertInternalCaller(req: {
  headers?: Record<string, string | string[] | undefined>;
}): void {
  const expected = expectedInternalToken();
  if (!expected) throw new NotFoundException();
  const raw = req.headers?.["x-internal-token"];
  const provided = Array.isArray(raw) ? raw[0] : raw;
  if (!provided || provided.length !== expected.length) throw new NotFoundException();
  const ok = timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  if (!ok) throw new NotFoundException();
}

function expectedInternalToken(): string | null {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;
  return createHash("sha256").update(`internal-api:${secret}`).digest("hex");
}
