import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A credential saved under another AUTH_SECRET (a backup restored on a fresh install) must fail with a message a
 * person can act on, not a bare "Unsupported state or unable to authenticate data".
 */
describe("stored credentials from another installation", () => {
  const saved = process.env.AUTH_SECRET;
  afterEach(() => {
    process.env.AUTH_SECRET = saved;
    vi.resetModules();
  });

  async function cryptoWith(secret: string) {
    vi.resetModules();
    process.env.AUTH_SECRET = secret;
    return import("../src/settings/crypto");
  }

  it("reads a credential saved under the same secret", async () => {
    const a = await cryptoWith("secret-one");
    expect(a.decryptStoredSecret(a.encryptSecret("hunter2"), "password")).toBe("hunter2");
  });

  it("says what to do when the secret differs", async () => {
    const a = await cryptoWith("secret-one");
    const enc = a.encryptSecret("hunter2");
    const b = await cryptoWith("secret-two");
    expect(() => b.decryptStoredSecret(enc, "SSH password")).toThrowError(b.UnreadableSecretError);
    expect(() => b.decryptStoredSecret(enc, "SSH password")).toThrowError(/saved SSH password cannot be read.*different AUTH_SECRET.*enter it again/);
  });

  it("a legacy cleartext value passes through", async () => {
    const a = await cryptoWith("secret-one");
    expect(a.decryptStoredSecret("plain", "password")).toBe("plain");
  });
});
