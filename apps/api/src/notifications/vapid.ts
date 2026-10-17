import { createECDH, hkdfSync } from "node:crypto";

export interface VapidKeys {
  /** The uncompressed P-256 public key, URL-safe base64: what the browser subscribes with. */
  publicKey: string;
  /** The 32-byte private scalar, URL-safe base64. */
  privateKey: string;
}

const SALT = "church-dashboard/web-push";

/**
 * The VAPID key pair that identifies this site to the browsers' push services, derived from `AUTH_SECRET` (the same way the
 * bundled object store's keys are). Nothing for the operator to set, nothing to store or race over, and every node of a cluster
 * has the same pair. Rotating `AUTH_SECRET` changes it, which makes existing subscriptions unusable (the push service refuses
 * them and they are removed); people turn push on again. **The derivation strings never change**: they are what ties existing
 * subscriptions to this site.
 */
export function deriveVapidKeys(secret: string): VapidKeys {
  if (!secret) throw new Error("AUTH_SECRET is required to derive the web push key");
  // A random 32 bytes is a valid P-256 scalar with overwhelming probability; the counter covers the rest.
  for (let counter = 0; counter < 16; counter++) {
    const ikm = Buffer.from(hkdfSync("sha256", secret, SALT, `vapid-v1-${counter}`, 32));
    const ecdh = createECDH("prime256v1");
    try {
      ecdh.setPrivateKey(ikm);
    } catch {
      continue;
    }
    return { publicKey: ecdh.getPublicKey().toString("base64url"), privateKey: ikm.toString("base64url") };
  }
  throw new Error("could not derive a web push key");
}
