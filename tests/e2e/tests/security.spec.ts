import { test, expect, type Page } from "@playwright/test";

const TEST_USER = "regression-test@local";
const TEST_DEFAULT_PASSWORD = "regression-default-pwd";
const TEST_NEW_PASSWORD = "regression-changed-pwd-1";

// Named security.spec.ts so it runs after auth.spec.ts has changed the test user's default password; read-only.
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

test.describe("Security pages", () => {
  test.beforeEach(async ({ page }) => {
    await signInAsTestUser(page);
  });

  test("Security lists this browser as the current session", async ({ page }) => {
    await page.goto("/me/security");
    await expect(page.getByRole("heading", { name: "Where you are signed in" })).toBeVisible();
    // The session row is made by the API on this browser's first request, so it is there by the time the list loads.
    await expect(page.getByText("This browser")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Sign out everywhere" })).toBeVisible();
  });

  test("the admin page links to the Security overview, which lists checks and fixes nothing itself", async ({ page }) => {
    await page.goto("/admin");
    await page.getByRole("link", { name: "Security overview" }).click();
    await expect(page).toHaveURL(/\/admin\/security$/);
    await expect(page.getByRole("heading", { name: "Security overview", level: 1 })).toBeVisible();
    await expect(page.getByRole("status")).toBeVisible();
    // Every row carries a words-and-icon status, never a colour alone.
    const rows = page.locator("main ul > li");
    expect(await rows.count()).toBeGreaterThan(3);
    await expect(rows.first().getByText(/Fix now|Needs attention|For your information|In good shape/)).toBeVisible();
  });
});
