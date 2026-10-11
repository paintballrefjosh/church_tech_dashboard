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
    await page.waitForURL((u) => !u.pathname.startsWith("/signin") || u.search.includes("error="), { timeout: 15_000 });
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

async function setScheme(page: Page, scheme: "light" | "dark") {
  await page.emulateMedia({ colorScheme: scheme });
  await page.evaluate((s) => localStorage.setItem("theme", s), scheme);
}

test.describe("Home look: Glass", () => {
  for (const scheme of ["light", "dark"] as const) {
    test(`renders in ${scheme}`, async ({ page }) => {
      await signInAsTestUser(page);
      await setScheme(page, scheme);
      await page.goto("/?theme=glass");
      const root = page.locator('[data-look="glass"]');
      await expect(root).toBeVisible();
      await expect(root.getByRole("heading", { level: 1 })).toBeVisible();

      // The window is one image with a summary; a test user without monitoring sees a line instead.
      const mosaic = root.getByRole("img");
      if (await mosaic.count()) {
        const label = await mosaic.first().getAttribute("aria-label");
        expect((label ?? "").length).toBeGreaterThan(0);
        await expect(root.getByText("Now, top row")).toBeVisible();
      }

      // At least one lower pane renders for this user.
      await expect(root.locator("article h2").first()).toBeVisible();
      const bg = await root.evaluate((el) => getComputedStyle(el).fontFamily);
      expect(bg.length).toBeGreaterThan(0);
    });
  }

  test("no horizontal page scroll at 390 px", async ({ page }) => {
    await signInAsTestUser(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/?theme=glass");
    await expect(page.locator('[data-look="glass"]')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
