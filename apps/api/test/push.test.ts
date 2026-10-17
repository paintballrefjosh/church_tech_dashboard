import { createECDH, createPublicKey, createVerify, randomBytes } from "node:crypto";
import webpush from "web-push";
import { describe, expect, it } from "vitest";
import { isAllowedPushEndpoint, pushPayloadFor, pushSubscribeSchema } from "@church/shared";
import { deriveVapidKeys } from "../src/notifications/vapid";

describe("deriveVapidKeys", () => {
  it("gives the same pair for the same secret, on any node", () => {
    expect(deriveVapidKeys("a-secret")).toEqual(deriveVapidKeys("a-secret"));
  });
  it("gives a different pair for a different secret", () => {
    expect(deriveVapidKeys("a-secret").publicKey).not.toBe(deriveVapidKeys("another-secret").publicKey);
  });
  it("makes a P-256 pair whose public half belongs to the private half", () => {
    const k = deriveVapidKeys("a-secret");
    const pub = Buffer.from(k.publicKey, "base64url");
    expect(pub).toHaveLength(65);
    expect(pub[0]).toBe(4);
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(Buffer.from(k.privateKey, "base64url"));
    expect(ecdh.getPublicKey().equals(pub)).toBe(true);
  });
  it("refuses to run without a secret", () => {
    expect(() => deriveVapidKeys("")).toThrow();
  });
  it("produces keys web-push accepts and signs a header a push service can verify", () => {
    const k = deriveVapidKeys("a-secret");
    // A browser's side of a subscription, made here.
    const browser = createECDH("prime256v1");
    browser.generateKeys();
    const sub = {
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      keys: { p256dh: browser.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") },
    };
    const details = webpush.generateRequestDetails(sub, JSON.stringify({ title: "hi" }), {
      vapidDetails: { subject: "https://church.example.org", publicKey: k.publicKey, privateKey: k.privateKey },
      TTL: 60,
    });
    const header = (details.headers as Record<string, string>).Authorization!;
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    expect(m).not.toBeNull();
    expect(m![2]).toBe(k.publicKey);
    const [h, p, sig] = m![1]!.split(".");
    const claims = JSON.parse(Buffer.from(p!, "base64url").toString()) as { aud: string; sub: string; exp: number };
    expect(claims.aud).toBe("https://fcm.googleapis.com");
    expect(claims.sub).toBe("https://church.example.org");
    const spki = createPublicKey({
      key: Buffer.concat([Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex"), Buffer.from(k.publicKey, "base64url")]),
      format: "der",
      type: "spki",
    });
    const ok = createVerify("SHA256")
      .update(`${h}.${p}`)
      .verify({ key: spki, dsaEncoding: "ieee-p1363" }, Buffer.from(sig!, "base64url"));
    expect(ok).toBe(true);
    // The body is encrypted for the browser: not readable as the JSON that went in.
    expect((details.body as Buffer).toString("utf8")).not.toContain("hi");
  });
});

describe("isAllowedPushEndpoint", () => {
  it("accepts the browsers' push services", () => {
    for (const u of [
      "https://fcm.googleapis.com/fcm/send/abc",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://web.push.apple.com/abc",
      "https://wns2-par02p.notify.windows.com/w/?token=abc",
    ]) {
      expect(isAllowedPushEndpoint(u), u).toBe(true);
    }
  });
  it("refuses anything that would make this server call somewhere else", () => {
    for (const u of [
      "http://fcm.googleapis.com/fcm/send/abc",
      "https://fcm.googleapis.com:8443/x",
      "https://user:pw@fcm.googleapis.com/x",
      "https://evilfcm.googleapis.com.example.org/x",
      "https://notfcm.googleapis.com.evil.test/x",
      "https://169.254.169.254/latest/meta-data",
      "https://localhost/x",
      "https://internal.church.lan/x",
      "not a url",
      "",
    ]) {
      expect(isAllowedPushEndpoint(u), u).toBe(false);
    }
  });
  it("is what the subscribe schema enforces", () => {
    const keys = { p256dh: "k", auth: "a" };
    expect(pushSubscribeSchema.safeParse({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys }).success).toBe(true);
    expect(pushSubscribeSchema.safeParse({ endpoint: "https://10.0.0.5/x", keys }).success).toBe(false);
  });
});

describe("pushPayloadFor", () => {
  it("shortens what a lock screen would cut off, on one line", () => {
    const p = pushPayloadFor({ kind: "ticket.comment", title: "T".repeat(300), body: "line one\n\nline two " + "x".repeat(400), link: "/tickets/1" });
    expect(p.title.length).toBeLessThanOrEqual(100);
    expect(p.body.length).toBeLessThanOrEqual(180);
    expect(p.body).not.toContain("\n");
    expect(p.url).toBe("/tickets/1");
    expect(p.kind).toBe("ticket.comment");
  });
  it("only ever points at this site", () => {
    expect(pushPayloadFor({ kind: "k", title: "t", link: "https://evil.example/x" }).url).toBe("/");
    expect(pushPayloadFor({ kind: "k", title: "t", link: "//evil.example/x" }).url).toBe("/");
    expect(pushPayloadFor({ kind: "k", title: "t", link: null }).url).toBe("/");
  });
});
