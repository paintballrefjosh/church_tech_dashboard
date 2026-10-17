/** Browser-side helpers for Web Push. Nothing here runs on the server. */

/** The application server key from the API (URL-safe base64) as the bytes `pushManager.subscribe` wants. */
export function urlBase64ToUint8Array(value: string): Uint8Array {
  const pad = "=".repeat((4 - (value.length % 4)) % 4);
  const raw = atob((value + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** The same short fingerprint the API gives each device (`endpointFingerprint`): the first 16 hex digits of SHA-256. */
export async function endpointFingerprint(endpoint: string): Promise<string> {
  const bytes = new TextEncoder().encode(endpoint);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

export type PushBlocker = "insecure" | "unsupported" | "denied";

/**
 * Why this browser cannot turn push on right now, or null if it can. Push needs a secure page (HTTPS, or localhost), a
 * service worker, the Push and Notification APIs, and permission that has not been refused.
 */
export function pushBlocker(): PushBlocker | null {
  if (typeof window === "undefined") return "unsupported";
  if (!window.isSecureContext) return "insecure";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  return null;
}

/**
 * The page's service worker, registered if it is not yet (the registrar does this on load, but a visit made before signing
 * in cannot), waiting at most `timeoutMs` for it to be active. `navigator.serviceWorker.ready` alone never settles when
 * nothing was registered.
 */
export async function serviceWorkerReady(timeoutMs = 10_000): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register("/sw.js");
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the service worker did not start")), timeoutMs));
  return Promise.race([navigator.serviceWorker.ready, timeout]);
}
