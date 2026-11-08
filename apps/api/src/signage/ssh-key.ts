import { createHash, createPrivateKey, createPublicKey, hkdfSync } from "node:crypto";

/**
 * The dashboard's SSH key for the signage Pis (docs/signage.md section 6): one Ed25519 pair for the whole site, DERIVED from
 * `AUTH_SECRET` and a generation number, like the web-push keys, so every node of a cluster has the same key and nothing is
 * stored. "Rotate key" moves to the next generation. **The derivation strings never change**: they are what ties the Pis'
 * authorized_keys to this site.
 */

const SALT = "church-dashboard/signage-ssh";

export interface SignageKeyPair {
  generation: number;
  /** OpenSSH private key (openssh-key-v1, unencrypted), what ssh2 reads. */
  privateKey: string;
  /** `ssh-ed25519 AAAA... church-dashboard-signage-g<n>` */
  publicKey: string;
  /** `SHA256:...` as ssh-keygen -l prints it. */
  fingerprint: string;
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}

function sshString(b: Buffer | string): Buffer {
  const buf = typeof b === "string" ? Buffer.from(b, "utf8") : b;
  return Buffer.concat([u32(buf.length), buf]);
}

export function deriveSignageKey(secret: string, generation: number): SignageKeyPair {
  if (!secret) throw new Error("AUTH_SECRET is required to derive the signage SSH key");
  if (!Number.isInteger(generation) || generation < 1) throw new Error("The key generation must be 1 or more");
  const seed = Buffer.from(hkdfSync("sha256", secret, SALT, `ed25519-v1-g${generation}`, 32));
  // PKCS#8 wrapper for an Ed25519 seed (RFC 8410), so node can compute the public half.
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const priv = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const spki = createPublicKey(priv).export({ format: "der", type: "spki" });
  const pub = spki.subarray(spki.length - 32);
  const comment = `church-dashboard-signage-g${generation}`;
  const pubBlob = Buffer.concat([sshString("ssh-ed25519"), sshString(pub)]);
  const check = createHash("sha256").update(seed).digest().readUInt32BE(0);
  let privSection = Buffer.concat([u32(check), u32(check), sshString("ssh-ed25519"), sshString(pub), sshString(Buffer.concat([seed, pub])), sshString(comment)]);
  const pad: number[] = [];
  for (let i = 1; (privSection.length + pad.length) % 8 !== 0; i++) pad.push(i);
  privSection = Buffer.concat([privSection, Buffer.from(pad)]);
  const body = Buffer.concat([Buffer.from("openssh-key-v1\0", "binary"), sshString("none"), sshString("none"), sshString(""), u32(1), sshString(pubBlob), sshString(privSection)]);
  const b64 = body.toString("base64").replace(/(.{70})/g, "$1\n").trim();
  return {
    generation,
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`,
    publicKey: `ssh-ed25519 ${pubBlob.toString("base64")} ${comment}`,
    fingerprint: `SHA256:${createHash("sha256").update(pubBlob).digest("base64").replace(/=+$/, "")}`,
  };
}

export function signageKey(generation: number): SignageKeyPair {
  return deriveSignageKey(process.env.AUTH_SECRET ?? "", generation);
}
