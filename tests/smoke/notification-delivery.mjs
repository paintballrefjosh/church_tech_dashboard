/**
 * Notification delivery smoke tests, run from run.mjs: quiet hours and the daily summary, push subscriptions (the address
 * rules, not a real push) and the push channel in the preferences. What is held and when it goes out is covered by
 * apps/api/test/notification-delivery.integration.test.ts. Everything changed here is put back before the block ends.
 * A real push is never sent: the only subscription made points at a made-up address and is removed again, and the test
 * route (which would call the browser vendor's server) is left alone.
 */
export async function notificationDeliveryTests({ test, assert, fetchWithCookies, jar }) {
  const json = (body) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const session = (path, init = {}) => fetchWithCookies(path, init, jar);
  const bearer = (token, path, init = {}) =>
    fetchWithCookies(path, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` } }, new Map());
  let token = null;
  let deviceId = null;
  let originalDelivery = null;
  let originalPrefs = null;

  try {
    originalDelivery = await (await session("/api/v1/me/notification-delivery")).res.json();
    originalPrefs = await (await session("/api/v1/me/notification-prefs")).res.json();

    await test("delivery: needs a session", async () => {
      const { res } = await fetchWithCookies("/api/v1/me/notification-delivery");
      assert(res.status === 401, `status ${res.status}`);
    });

    await test("delivery: defaults to everything immediate, with the site's time zone", async () => {
      const d = originalDelivery;
      assert(typeof d.timeZone === "string" && d.timeZone.length > 0, `zone ${d.timeZone}`);
      for (const k of ["quietEnabled", "digestEnabled", "urgentThrough", "quietStart", "quietEnd", "digestAt"]) assert(k in d, `missing ${k}`);
    });

    await test("delivery: save quiet hours and a summary, and read them back", async () => {
      const want = { quietEnabled: true, quietStart: 22 * 60 + 30, quietEnd: 6 * 60, digestEnabled: true, digestAt: 8 * 60 + 15, urgentThrough: false };
      const put = await session("/api/v1/me/notification-delivery", { method: "PUT", ...json(want) });
      assert(put.res.status === 200, `put status ${put.res.status}`);
      const got = await (await session("/api/v1/me/notification-delivery")).res.json();
      for (const [k, v] of Object.entries(want)) assert(got[k] === v, `${k}: ${got[k]} != ${v}`);
    });

    await test("delivery: quiet hours that start and end together, or a time off the clock, are refused", async () => {
      const base = { quietEnabled: true, quietStart: 600, quietEnd: 600, digestEnabled: false, digestAt: 480, urgentThrough: true };
      assert((await session("/api/v1/me/notification-delivery", { method: "PUT", ...json(base) })).res.status === 400, "same start and end");
      assert((await session("/api/v1/me/notification-delivery", { method: "PUT", ...json({ ...base, quietEnd: 60, digestAt: 1440 }) })).res.status === 400, "1440");
      assert((await session("/api/v1/me/notification-delivery", { method: "PUT", ...json({ quietEnabled: true }) })).res.status === 400, "partial");
    });

    await test("delivery: changing it is audited", async () => {
      await new Promise((r) => setTimeout(r, 300));
      const { res } = await session("/api/v1/audit?action=user.notificationDelivery.update&limit=5");
      assert(res.status === 200, `audit status ${res.status}`);
      const body = await res.json();
      const rows = Array.isArray(body) ? body : (body.items ?? body.rows ?? []);
      assert(rows.length >= 1, `no audit row ${JSON.stringify(body).slice(0, 200)}`);
    });

    await test("push: status gives the site key and no devices", async () => {
      const { res } = await session("/api/v1/me/push");
      assert(res.status === 200, `status ${res.status}`);
      const p = await res.json();
      assert(p.enabled === true, "push should be on by default");
      assert(typeof p.publicKey === "string" && Buffer.from(p.publicKey, "base64url").length === 65, "public key is a 65 byte P-256 point");
      assert(Array.isArray(p.devices), "devices list");
    });

    await test("push: only a browser vendor's push address is accepted", async () => {
      const keys = { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" };
      for (const endpoint of ["https://internal.church.lan/push", "http://fcm.googleapis.com/fcm/send/x", "https://169.254.169.254/x", "https://fcm.googleapis.com:8443/x"]) {
        const { res } = await session("/api/v1/me/push/subscriptions", { method: "POST", ...json({ endpoint, keys }) });
        assert(res.status === 400, `${endpoint} -> ${res.status}`);
      }
      const ok = await session("/api/v1/me/push/subscriptions", { method: "POST", ...json({ endpoint: "https://fcm.googleapis.com/fcm/send/smoke-made-up-device", keys }) });
      assert(ok.res.status === 200 || ok.res.status === 201, `subscribe status ${ok.res.status}`);
      deviceId = (await ok.res.json()).id;
      assert(typeof deviceId === "string", "device id");
    });

    await test("push: the device is listed without its address or keys", async () => {
      const text = await (await session("/api/v1/me/push")).res.text();
      const p = JSON.parse(text);
      assert(p.devices.some((d) => d.id === deviceId), "device listed");
      assert(!text.includes("smoke-made-up-device") && !text.includes("tBHItJI5"), "the address or keys leaked into the list");
      assert(p.devices.every((d) => /^[0-9a-f]{16}$/.test(d.fingerprint)), "fingerprint");
    });

    await test("push: a subscription is not available to an API token (session only)", async () => {
      const made = await session("/api/v1/me/api-tokens", { method: "POST", ...json({ name: "smoke push", readOnly: false, expiresInDays: 1 }) });
      assert(made.res.status === 200 || made.res.status === 201, `token status ${made.res.status}`);
      token = await made.res.json();
      assert((await bearer(token.token, "/api/v1/me/push")).res.status === 403, "list");
      assert((await bearer(token.token, "/api/v1/me/push/subscriptions", { method: "POST", ...json({ endpoint: "https://fcm.googleapis.com/fcm/send/x", keys: { p256dh: "a", auth: "b" } }) })).res.status === 403, "subscribe");
      // The delivery choices themselves are an ordinary personal setting.
      assert((await bearer(token.token, "/api/v1/me/notification-delivery")).res.status === 200, "delivery read");
    });

    await test("push: removing a device, and a stranger's or unknown id", async () => {
      assert((await session("/api/v1/me/push/subscriptions/not-a-uuid", { method: "DELETE" })).res.status === 400, "bad id");
      assert((await session("/api/v1/me/push/subscriptions/00000000-0000-4000-8000-000000000000", { method: "DELETE" })).res.status === 404, "unknown");
      const del = await session(`/api/v1/me/push/subscriptions/${deviceId}`, { method: "DELETE" });
      assert(del.res.status === 200, `delete status ${del.res.status}`);
      deviceId = null;
      const p = await (await session("/api/v1/me/push")).res.json();
      assert(p.devices.length === 0, "device should be gone");
    });

    await test("prefs: push can be chosen per kind", async () => {
      const put = await session("/api/v1/me/notification-prefs", { method: "PUT", ...json({ channels: { "ticket.comment": ["in_app", "push"] } }) });
      assert(put.res.status === 200, `put status ${put.res.status}`);
      const got = await (await session("/api/v1/me/notification-prefs")).res.json();
      assert(JSON.stringify(got.channels["ticket.comment"]) === JSON.stringify(["in_app", "push"]), JSON.stringify(got.channels["ticket.comment"]));
      const bad = await session("/api/v1/me/notification-prefs", { method: "PUT", ...json({ channels: { "ticket.comment": ["sms"] } }) });
      assert(bad.res.status === 400, `unknown channel status ${bad.res.status}`);
    });
  } finally {
    if (deviceId) await session(`/api/v1/me/push/subscriptions/${deviceId}`, { method: "DELETE" }).catch(() => undefined);
    if (token) await session(`/api/v1/me/api-tokens/${token.id}`, { method: "DELETE" }).catch(() => undefined);
    if (originalDelivery) {
      const { timeZone, ...rest } = originalDelivery;
      await session("/api/v1/me/notification-delivery", { method: "PUT", ...json(rest) }).catch(() => undefined);
    }
    if (originalPrefs) {
      // Put the per-kind channels back exactly (a kind with no saved row is left as it was written, which is fine).
      const channels = originalPrefs.channels ?? {};
      if (Object.keys(channels).length === 0) {
        await session("/api/v1/me/notification-prefs", { method: "PUT", ...json({ channels: { "ticket.comment": ["in_app", "email"] } }) }).catch(() => undefined);
      } else {
        await session("/api/v1/me/notification-prefs", { method: "PUT", ...json({ channels }) }).catch(() => undefined);
      }
    }
  }
}
