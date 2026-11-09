import { blockedAddress } from "./schemas/livestream";

/**
 * Hosts that mean "something inside this stack": the compose network resolves a one-word name to a container, so a
 * setting that names one would let an admin point a connector at the API, the database or the object store.
 */
export const STACK_HOST_NAMES: ReadonlySet<string> = new Set(["api", "web", "proxy", "caddy", "meilisearch", "garage", "monitor", "cockroach", "localhost"]);

/**
 * Why the dashboard may not connect OUT to this host, or null when it may. Pure, so a setting can be refused when it is
 * saved; the connecting code asks again after DNS (`assertContactHost` in the API), because a name can point anywhere.
 * Private LAN addresses are allowed: a mail server or a switch on the church network is the point.
 */
export function contactHostProblem(host: string): string | null {
  const h = host.trim().replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "") return null;
  if (blockedAddress(h)) return `${h} is not an address the dashboard may contact (this machine itself, or a link-local address).`;
  const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":");
  if (!isIpLiteral && (STACK_HOST_NAMES.has(h) || /^cockroach/.test(h) || !h.includes("."))) {
    return `"${h}" is not allowed: use the server's full name or its address.`;
  }
  return null;
}
