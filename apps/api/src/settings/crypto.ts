import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * AES-256-GCM encryption for `secret`-typed settings (OAuth client secrets,
 * SMTP passwords, UniFi API keys, ProPresenter password, Planning Center
 * token). The key is derived from AUTH_SECRET via scrypt, so a backup of
 * data/cockroach-1/ alone is useless — you need the .env (with AUTH_SECRET)
 * as well to decrypt anything.
 *
 * Wire format: `enc:v1:<iv-base64>:<auth-tag-base64>:<ciphertext-base64>`.
 * The `enc:v1:` prefix lets us distinguish encrypted blobs from legacy
 * cleartext strings, so the service can transparently upgrade old rows on
 * the next write without a bulk migration.
 */
const PREFIX = "enc:v1:";
const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const SALT = Buffer.from("lampstand:settings:v1");
/**
 * Values saved before the rename to Lampstand (2026-11-08) were encrypted under this salt. They are still read (see
 * `decryptSecret`) and become new-salt values the next time they are saved; nothing is re-encrypted in bulk.
 */
const LEGACY_SALT = Buffer.from("church-dashboard:settings:v1");

let cachedKey: Buffer | null = null;
let cachedLegacyKey: Buffer | null = null;

function secretOrThrow(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET must be set before encrypting/decrypting settings");
  return secret;
}

function key(): Buffer {
  if (!cachedKey) cachedKey = scryptSync(secretOrThrow(), SALT, 32);
  return cachedKey;
}

function legacyKey(): Buffer {
  if (!cachedLegacyKey) cachedLegacyKey = scryptSync(secretOrThrow(), LEGACY_SALT, 32);
  return cachedLegacyKey;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

export function isEncrypted(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(PREFIX);
}

export function decryptSecret(encrypted: string): string {
  if (!isEncrypted(encrypted)) {
    // Legacy cleartext value (pre-encryption). Return as-is so the service
    // works during the rolling-upgrade window before all rows are re-encrypted.
    return encrypted;
  }
  const [, , ivB64, tagB64, ctB64] = encrypted.split(":");
  if (!ivB64 || !tagB64 || !ctB64) throw new Error("malformed encrypted setting");
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ct = Buffer.from(ctB64, "base64");
  const open = (k: Buffer): string => {
    const decipher = createDecipheriv(ALGO, k, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  };
  try {
    return open(key());
  } catch (err) {
    // Saved before the rename? A value that opens under neither salt was written under another AUTH_SECRET.
    try {
      return open(legacyKey());
    } catch {
      throw err;
    }
  }
}

/**
 * A stored password or key that this installation cannot decrypt: it was encrypted under a different
 * AUTH_SECRET (the usual way: a backup restored on a fresh install). The message is meant to be shown to
 * a person next to the device it belongs to.
 */
export class UnreadableSecretError extends Error {
  constructor(what: string) {
    super(
      `The saved ${what} cannot be read: it was saved by an installation with a different AUTH_SECRET (a restored backup, for example). Edit this entry and enter it again.`,
    );
    this.name = "UnreadableSecretError";
  }
}

/** decryptSecret for a credential: a value that cannot be decrypted becomes an UnreadableSecretError. */
export function decryptStoredSecret(encrypted: string, what: string): string {
  try {
    return decryptSecret(encrypted);
  } catch (err) {
    if ((err as Error).message.includes("AUTH_SECRET must be set")) throw err;
    throw new UnreadableSecretError(what);
  }
}
