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

test.describe.configure({ mode: "serial" });

for (const scheme of ["light", "dark"] as const) {
  test.describe(`Home look: Nave (${scheme})`, () => {
    test.use({ colorScheme: scheme });

    test.beforeEach(async ({ page }) => {
      await page.addInitScript((value) => {
        try {
          window.localStorage.setItem("theme", value);
        } catch {
          /* storage unavailable */
        }
      }, scheme);
      await signInAsTestUser(page);
      await page.goto("/?theme=nave");
    });

    test("renders the arches, the hero and the windows", async ({ page }) => {
      const root = page.locator('[data-look="nave"]');
      await expect(root).toBeVisible();
      await expect(root.locator("svg").first()).toBeAttached();
      await expect(root.getByRole("heading", { level: 1 })).toBeVisible();
      // The regression user is an admin: monitoring, tickets and the needs list are all readable.
      await expect(root.getByRole("heading", { name: "Systems" })).toBeVisible();
      await expect(root.getByRole("heading", { name: "For you" })).toBeVisible();
      await expect(root.getByRole("heading", { name: "This week" })).toBeVisible();
      await expect(root.getByRole("heading", { name: "Start something" })).toBeVisible();
      const dark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
      expect(dark).toBe(scheme === "dark");
    });

    test("has no horizontal scroll at phone width", async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto("/?theme=nave");
      await expect(page.locator('[data-look="nave"]')).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });
  });
}

test("the sign-in page still renders its chapel window", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/signin");
  await expect(page.locator("aside svg path.auth-arch")).toHaveCount(9);
  await ctx.close();
});
