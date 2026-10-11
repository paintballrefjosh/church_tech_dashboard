import { test, expect, type Page } from "@playwright/test";

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

test.describe("Home look: Start page", () => {
  test.beforeEach(async ({ page }) => {
    await signInAsTestUser(page);
  });

  test("renders the greeting, search, and needs section", async ({ page }) => {
    await page.goto("/?theme=start");
    const look = page.locator('[data-look="start"]');
    await expect(look).toBeVisible();
    await expect(look.getByRole("heading", { level: 1 })).toHaveText(/^Good (morning|afternoon|evening), /);

    const search = look.getByRole("searchbox", { name: "Search everything" });
    await search.fill("the");
    await expect(look.getByRole("region", { name: "Search results" })).toBeVisible();
    await search.fill("");

    const needs = look.getByRole("region", { name: "Needs you" });
    await expect(needs).toBeVisible();
    const empty = needs.getByText("Nothing needs you right now.");
    const unavailable = needs.getByText("can't be shown right now");
    const groups = needs.getByRole("heading", { level: 3 });
    await expect(empty.or(unavailable).or(groups.first())).toBeVisible();
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`renders in ${scheme} mode without horizontal overflow at 390 px`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.addInitScript((t) => {
        try {
          localStorage.setItem("theme", t);
        } catch {
          /* ignore */
        }
      }, scheme);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto("/?theme=start");
      const look = page.locator('[data-look="start"]');
      await expect(look).toBeVisible();
      await expect(page.locator("html")).toHaveClass(scheme === "dark" ? /dark/ : /^((?!dark).)*$/);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }
});
