import { test, expect, type BrowserContext, type Page } from "@playwright/test";

const TEST_USER = "regression-test@local";
const TEST_DEFAULT_PASSWORD = "regression-default-pwd";
const TEST_NEW_PASSWORD = "regression-changed-pwd-1";

// Runs after auth.spec.ts has changed the test user's default password. Settings changed here are put back afterwards.
// Whether a held email goes out at the right time is covered by apps/api/test/notification-delivery.integration.test.ts.
// The browser's push service is replaced by a stub (see stubPush): a real subscription needs the vendor's servers.
test.describe.configure({ mode: "serial" });

async function signInAsTestUser(page: Page) {
  async function attempt(password: string) {
    await page.goto("/signin");
    await page.getByLabel("Email or username").fill(TEST_USER);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/signin") || u.search.includes("error="), { timeout: 15_000 });
  }
  await attempt(TEST_NEW_PASSWORD);
  if (page.url().includes("/signin")) {
    await attempt(TEST_DEFAULT_PASSWORD);
    if (page.url().includes("/change-password")) {
      await page.getByLabel("New password").fill(TEST_NEW_PASSWORD);
      await page.getByLabel("Confirm password").fill(TEST_NEW_PASSWORD);
      await Promise.all([page.waitForURL(/\/signin/, { timeout: 15_000 }), page.getByRole("button", { name: /save new password/i }).click()]);
      await attempt(TEST_NEW_PASSWORD);
    }
  }
}


/**
 * A stand-in for the browser's push manager: subscribing gives a fixed fake subscription on an address the server accepts,
 * and it lasts for the tab (sessionStorage) so a reload still knows it is subscribed. The permission is stubbed too: headless
 * Chromium reports Notification.permission as "denied" even where the permissions API says "granted".
 */
async function stubPush(page: Page) {
  await page.addInitScript(() => {
    const KEY = "e2e-push-subscribed";
    const PERM = "e2e-push-permission";
    Object.defineProperty(Notification, "permission", { configurable: true, get: () => sessionStorage.getItem(PERM) ?? "default" });
    Object.defineProperty(Notification, "requestPermission", {
      configurable: true,
      value: async () => {
        sessionStorage.setItem(PERM, "granted");
        return "granted";
      },
    });
    const endpoint = "https://fcm.googleapis.com/fcm/send/e2e-fake-device";
    const sub = {
      endpoint,
      toJSON: () => ({
        endpoint,
        keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" },
      }),
      unsubscribe: async () => {
        sessionStorage.removeItem(KEY);
        return true;
      },
    };
    Object.defineProperty(PushManager.prototype, "subscribe", {
      configurable: true,
      value: async () => {
        sessionStorage.setItem(KEY, "1");
        return sub;
      },
    });
    Object.defineProperty(PushManager.prototype, "getSubscription", {
      configurable: true,
      value: async () => (sessionStorage.getItem(KEY) ? sub : null),
    });
  });
}

async function restoreSettings(page: Page) {
  await page.goto("/me");
  await page.evaluate(async () => {
    const j = { "content-type": "application/json" };
    const push = (await (await fetch("/api/v1/me/push", { credentials: "same-origin" })).json()) as { devices: Array<{ id: string }> };
    for (const d of push.devices) await fetch(`/api/v1/me/push/subscriptions/${d.id}`, { method: "DELETE", credentials: "same-origin" });
    await fetch("/api/v1/me/notification-delivery", {
      method: "PUT",
      credentials: "same-origin",
      headers: j,
      body: JSON.stringify({ quietEnabled: false, quietStart: 1320, quietEnd: 420, digestEnabled: false, digestAt: 480, urgentThrough: true }),
    });
    await fetch("/api/v1/me/notification-prefs", {
      method: "PUT",
      credentials: "same-origin",
      headers: j,
      body: JSON.stringify({ channels: { "ticket.assigned": ["in_app", "email"] } }),
    });
  });
}

// One sign-in for the file: sign-in has a strict per-minute limit.
let context: BrowserContext;
let page: Page;
test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ permissions: ["notifications"] });
  page = await context.newPage();
  await stubPush(page);
  await signInAsTestUser(page);
});
test.afterEach(async () => {
  await restoreSettings(page);
});
test.afterAll(async () => {
  await context.close();
});

test("quiet hours and the daily summary are saved and still there after a reload", async () => {
  await page.goto("/me");
  const form = page.getByTestId("delivery-form");
  await expect(form).toBeVisible();
  await expect(page.getByTestId("delivery-quiet")).not.toBeChecked();
  await expect(page.getByTestId("delivery-quiet-start")).toBeDisabled();
  await expect(page.getByTestId("delivery-urgent")).toBeChecked();

  await page.getByTestId("delivery-quiet").check();
  await expect(page.getByTestId("delivery-quiet-start")).toBeEnabled();
  await page.getByTestId("delivery-quiet-start").fill("23:00");
  await page.getByTestId("delivery-quiet-end").fill("06:30");
  await page.getByTestId("delivery-digest").check();
  await page.getByTestId("delivery-digest-at").fill("09:15");
  await page.getByTestId("delivery-urgent").uncheck();
  await page.getByTestId("delivery-save").click();
  await expect(form.getByRole("status")).toHaveText("Saved.");

  await page.reload();
  await expect(page.getByTestId("delivery-quiet")).toBeChecked();
  await expect(page.getByTestId("delivery-quiet-start")).toHaveValue("23:00");
  await expect(page.getByTestId("delivery-quiet-end")).toHaveValue("06:30");
  await expect(page.getByTestId("delivery-digest")).toBeChecked();
  await expect(page.getByTestId("delivery-digest-at")).toHaveValue("09:15");
  await expect(page.getByTestId("delivery-urgent")).not.toBeChecked();
});

test("quiet hours that start and end together are refused with a message", async () => {
  await page.goto("/me");
  await page.getByTestId("delivery-quiet").check();
  await page.getByTestId("delivery-quiet-start").fill("07:00");
  await page.getByTestId("delivery-quiet-end").fill("07:00");
  await page.getByTestId("delivery-save").click();
  await expect(page.getByTestId("delivery-form").getByRole("alert")).toBeVisible();
});

test("push: turn it on for this browser, choose a kind, then remove the browser", async () => {
  await page.goto("/me");
  const panel = page.getByTestId("push-panel");
  await expect(panel).toBeVisible();
  // Until a browser is on, the preferences table cannot choose push.
  await expect(page.getByTestId("pref-push-ticket.assigned")).toBeDisabled();
  await expect(page.getByTestId("push-devices")).toHaveCount(0);

  await page.getByTestId("push-enable").click();
  await expect(page.getByTestId("push-status")).toBeVisible();
  const device = page.getByTestId("push-device");
  await expect(device).toHaveCount(1);
  await expect(device).toContainText("this browser");
  await expect(page.getByTestId("pref-push-ticket.assigned")).toBeEnabled();

  await page.getByTestId("pref-push-ticket.assigned").check();
  await page.getByRole("button", { name: "Save preferences" }).click();
  await expect(page.getByText("Preferences saved.")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("pref-push-ticket.assigned")).toBeChecked();
  await expect(page.getByTestId("push-status")).toBeVisible();

  await device.getByRole("button", { name: /^Remove/ }).click();
  await expect(page.getByTestId("push-device")).toHaveCount(0);
  await expect(page.getByTestId("push-enable")).toBeVisible();
  await expect(page.getByTestId("pref-push-ticket.assigned")).toBeDisabled();
});

test("push: the page says why it cannot be turned on where the browser refuses", async ({ browser }) => {
  const refused = await browser.newContext({ permissions: [] });
  const tab = await refused.newPage();
  await tab.addInitScript(() => {
    Object.defineProperty(Notification, "permission", { configurable: true, get: () => "denied" });
  });
  await signInAsTestUser(tab);
  await tab.goto("/me");
  await expect(tab.getByTestId("push-blocker")).toContainText("blocked");
  await expect(tab.getByTestId("push-enable")).toHaveCount(0);
  await refused.close();
});
