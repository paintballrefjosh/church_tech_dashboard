import { test, expect, type Page } from "@playwright/test";

const TEST_USER = "regression-test@local";
const TEST_DEFAULT_PASSWORD = "regression-default-pwd";
const TEST_NEW_PASSWORD = "regression-changed-pwd-1";

async function signInAsTestUser(page: Page) {
  async function attempt(password: string) {
    await page.goto("/signin");
    await page.getByLabel("Email or username").fill(TEST_USER);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/signin") || u.search.includes("error="), {
      timeout: 15_000,
    });
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

// Nothing here clicks mute, Ack or a checklist box: they act on the real system.
test.describe("Home look: Front of House", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ page }) => {
    await signInAsTestUser(page);
  });

  test("renders the console with strips, meters and the main strip", async ({ page }) => {
    await page.goto("/?theme=front-of-house");
    const root = page.locator('[data-look="front-of-house"]');
    await expect(root).toBeVisible();
    await expect(root.getByRole("heading", { level: 1 })).toBeVisible();
    const main = page.getByTestId("foh-main-strip");
    await expect(main).toBeVisible();
    await expect(main.getByRole("link", { name: "Open monitoring" })).toBeVisible();
    // The test user can read monitors, so every area it can see has a strip.
    const strips = page.locator('[data-testid^="foh-strip-"]');
    expect(await strips.count()).toBeGreaterThan(0);
    for (const strip of await strips.all()) {
      await expect(strip.getByRole("link", { name: /^Open/ })).toBeVisible();
      // A meter exposes a value, or says the reading is unavailable.
      const meter = strip.locator('[role="meter"], [role="img"][aria-label$="reading unavailable"]');
      await expect(meter).toHaveCount(1);
      if ((await meter.getAttribute("role")) === "meter") {
        const value = Number(await meter.getAttribute("aria-valuenow"));
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(100);
        expect(await meter.getAttribute("aria-valuetext")).toBeTruthy();
      }
    }
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`renders in the ${scheme} scheme`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.addInitScript((t) => localStorage.setItem("theme", t), scheme);
      await page.goto("/?theme=front-of-house");
      const root = page.locator('[data-look="front-of-house"]');
      await expect(root).toBeVisible();
      const isDark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
      expect(isDark).toBe(scheme === "dark");
      // The look paints its own background, and it differs between the schemes.
      const bg = await root.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(bg).toBe(scheme === "dark" ? "rgb(29, 32, 37)" : "rgb(217, 221, 227)");
    });
  }

  test("kiosk hides the navigation and the picker", async ({ page }) => {
    await page.goto("/?theme=front-of-house&kiosk=1");
    await expect(page.locator('[data-look="front-of-house"]')).toBeVisible();
    await expect(page.getByTestId("look-picker-open")).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /^(Ticket|Wiki page|Note)$/ })).toHaveCount(0);
  });

  test("has no horizontal page scroll at 390 px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/?theme=front-of-house");
    await expect(page.locator('[data-look="front-of-house"]')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
