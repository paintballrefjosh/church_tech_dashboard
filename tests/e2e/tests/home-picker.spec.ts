import { test, expect, type Page } from "@playwright/test";

/**
 * Home page look: the URL preview, the picker dialog, a look saved to the account and a look pinned
 * to this device. Every test starts from a tiles preview (`?theme=tiles`), so it does not depend on
 * which look is the site default; where the site default matters it is read from the prefs API. The
 * test user's saved look and device cookie are reset around every test.
 */

const TEST_USER = "regression-test@local";
const TEST_DEFAULT_PASSWORD = "regression-default-pwd";
const TEST_NEW_PASSWORD = "regression-changed-pwd-1";

test.describe.configure({ mode: "serial" });

async function signInAsTestUser(page: Page) {
  async function attempt(password: string) {
    await page.goto("/signin");
    await page.getByLabel("Email or username").fill(TEST_USER);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(
      (u) => !u.pathname.startsWith("/signin") || u.search.includes("error="),
      { timeout: 15_000 },
    );
  }
  await attempt(TEST_NEW_PASSWORD);
  if (page.url().includes("/signin")) {
    await attempt(TEST_DEFAULT_PASSWORD);
    if (page.url().includes("/change-password")) {
      await page.getByLabel("New password").fill(TEST_NEW_PASSWORD);
      await page.getByLabel("Confirm password").fill(TEST_NEW_PASSWORD);
      await Promise.all([
        page.waitForURL(/\/signin/, { timeout: 15_000 }),
        page.getByRole("button", { name: /save new password/i }).click(),
      ]);
      await attempt(TEST_NEW_PASSWORD);
    }
  }
}

interface Prefs {
  theme: string | null;
  siteDefault: string;
  available: string[];
}

async function getPrefs(page: Page): Promise<Prefs> {
  return page.evaluate(async () => {
    const r = await fetch("/api/dashboard/prefs", { credentials: "same-origin" });
    return (await r.json()) as Prefs;
  });
}

async function putTheme(page: Page, theme: string | null): Promise<number> {
  return page.evaluate(async (t) => {
    const r = await fetch("/api/dashboard/prefs", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ theme: t }),
    });
    return r.status;
  }, theme);
}

async function setDeviceLook(page: Page, look: string | null): Promise<number> {
  return page.evaluate(async (l) => {
    const r = await fetch("/api/dashboard/device-look", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ look: l }),
    });
    return r.status;
  }, look);
}

async function resetLook(page: Page) {
  expect(await putTheme(page, null)).toBe(200);
  expect(await setDeviceLook(page, null)).toBe(200);
}

async function openPicker(page: Page) {
  await page.getByTestId("look-picker-open").click();
  const dialog = page.getByRole("dialog", { name: "Choose a home page look" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe("Home page look", () => {
  test.beforeEach(async ({ page }) => {
    await signInAsTestUser(page);
    await resetLook(page);
    await page.goto("/?theme=tiles");
    await expect(page.locator('[data-look="tiles"]')).toBeVisible();
  });

  test.afterEach(async ({ page }) => {
    await resetLook(page);
  });

  test("?theme= previews a look without saving it", async ({ page }) => {
    await page.goto("/?theme=start");
    await expect(page.locator('[data-look="start"]')).toBeVisible();
    const prefs = await getPrefs(page);
    expect(prefs.theme).toBeNull();
    // The preview is not remembered: the plain address shows the site default again.
    await page.goto("/");
    await expect(page.locator(`[data-look="${prefs.siteDefault}"]`)).toBeVisible();
  });

  test("the picker lists looks, marks the current one and closes with Escape", async ({ page }) => {
    const dialog = await openPicker(page);
    await expect(dialog.getByTestId("look-option-tiles")).toHaveAttribute("aria-current", "true");
    await expect(dialog.getByTestId("look-option-start")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("a look chosen in the picker is saved and survives a reload", async ({ page }) => {
    const dialog = await openPicker(page);
    await dialog.getByTestId("look-option-start").click();
    await expect(page.locator('[data-look="start"]')).toBeVisible();
    expect((await getPrefs(page)).theme).toBe("start");
    await page.reload();
    await expect(page.locator('[data-look="start"]')).toBeVisible();
  });

  test("a look used on this device only wins over the saved look and can be cleared", async ({ page }) => {
    expect(await putTheme(page, "start")).toBe(200);
    await page.goto("/");
    await expect(page.locator('[data-look="start"]')).toBeVisible();

    // Pin tiles to this device (the one look that always has the picker button), via the picker's
    // own route; the saved look stays "start".
    expect(await setDeviceLook(page, "tiles")).toBe(200);
    await page.reload();
    await expect(page.locator('[data-look="tiles"]')).toBeVisible();
    expect((await getPrefs(page)).theme).toBe("start");

    const dialog = await openPicker(page);
    await expect(dialog.getByTestId("look-picker-device-note")).toBeVisible();
    await dialog.getByRole("button", { name: "Stop using a look just on this device" }).click();
    await expect(page.locator('[data-look="start"]')).toBeVisible();
    await page.reload();
    await expect(page.locator('[data-look="start"]')).toBeVisible();
  });

  test("the device-only checkbox pins the look to this browser, not the account", async ({ page }) => {
    const dialog = await openPicker(page);
    await dialog.getByLabel("Use on this device only").check();
    await dialog.getByTestId("look-option-start").click();
    await expect(page.locator('[data-look="start"]')).toBeVisible();
    expect((await getPrefs(page)).theme).toBeNull();
    const cookies = await page.context().cookies();
    const cookie = cookies.find((c) => c.name === "church_home_look");
    expect(cookie?.value).toBe("start");
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.secure).toBe(false);
  });

  test("Use the site default clears the saved look", async ({ page }) => {
    expect(await putTheme(page, "start")).toBe(200);
    await page.goto("/?theme=tiles");
    const dialog = await openPicker(page);
    await dialog.getByRole("button", { name: "Use the site default" }).click();
    await expect.poll(async () => (await getPrefs(page)).theme).toBeNull();
    await expect(page.locator(`[data-look="${(await getPrefs(page)).siteDefault}"]`)).toBeVisible();
  });

  test("the profile page offers the same choice", async ({ page }) => {
    await page.goto("/me#home-look");
    const select = page.getByTestId("home-look-select");
    await expect(select).toBeVisible();
    await select.selectOption("start");
    await expect.poll(async () => (await getPrefs(page)).theme).toBe("start");
  });

  test("the API refuses an unknown look", async ({ page }) => {
    expect(await putTheme(page, "no-such-look")).toBe(400);
  });
});
