import { test, expect } from "@playwright/test";

// Match apps/api/src/scripts/reset-test-user.ts. The bootstrap admin user
// is NEVER touched by these tests — we operate on a dedicated test user
// instead so an operator's real admin password is safe.
const TEST_USER = "regression-test@local";
const TEST_DEFAULT_PASSWORD = "regression-default-pwd";
const TEST_NEW_PASSWORD = "regression-changed-pwd-1";

test.describe.configure({ mode: "serial" });

test.describe("Phase 0 — auth + dashboard shell", () => {
  test("unauthed visit redirects to /signin", async ({ page }) => {
    const response = await page.goto("/");
    expect(page).toHaveURL(/\/signin/);
    expect(response?.status()).toBeLessThan(400);
  });

  test("sign-in page renders the form", async ({ page }) => {
    await page.goto("/signin");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(page.getByLabel("Email or username")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
  });

  test("theme toggle switches between light and dark", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/signin");
    const html = page.locator("html");
    const toggle = page.getByLabel("Toggle theme");
    await expect(toggle).toBeVisible();
    await expect(html).toHaveClass(/light/);
    await toggle.click();
    await expect(html).toHaveClass(/dark/);
    await toggle.click();
    await expect(html).toHaveClass(/light/);
  });

  test("test user with default password lands on /change-password", async ({ page }) => {
    await page.goto("/signin");
    await page.getByLabel("Email or username").fill(TEST_USER);
    await page.getByLabel("Password").fill(TEST_DEFAULT_PASSWORD);
    await Promise.all([
      page.waitForURL(/\/change-password/, { timeout: 15_000 }),
      page.getByRole("button", { name: "Sign in" }).click(),
    ]);
    await expect(page.getByRole("heading", { name: /set a new password/i })).toBeVisible();
  });

  test("changing the password signs out, then signing in with the new password reaches the dashboard", async ({ page }) => {
    await page.goto("/signin");
    await page.getByLabel("Email or username").fill(TEST_USER);
    await page.getByLabel("Password").fill(TEST_DEFAULT_PASSWORD);
    await Promise.all([
      page.waitForURL(/\/change-password/, { timeout: 15_000 }),
      page.getByRole("button", { name: "Sign in" }).click(),
    ]);

    await page.getByLabel("New password").fill(TEST_NEW_PASSWORD);
    await page.getByLabel("Confirm password").fill(TEST_NEW_PASSWORD);
    await Promise.all([
      page.waitForURL(/\/signin/, { timeout: 15_000 }),
      page.getByRole("button", { name: /save new password/i }).click(),
    ]);

    await page.getByLabel("Email or username").fill(TEST_USER);
    await page.getByLabel("Password").fill(TEST_NEW_PASSWORD);
    await Promise.all([
      page.waitForURL((url) => url.pathname === "/", { timeout: 15_000 }),
      page.getByRole("button", { name: "Sign in" }).click(),
    ]);
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  });

  test("sign-out returns to /signin", async ({ page }) => {
    await page.goto("/signin");
    await page.getByLabel("Email or username").fill(TEST_USER);
    await page.getByLabel("Password").fill(TEST_NEW_PASSWORD);
    await Promise.all([
      page.waitForURL((url) => url.pathname === "/", { timeout: 15_000 }),
      page.getByRole("button", { name: "Sign in" }).click(),
    ]);
    // Sign out now lives inside the username dropdown. Open the user menu
    // (the trigger button shows the user's email), then click Sign out.
    await page.locator('button[aria-haspopup="menu"]').filter({ hasText: TEST_USER }).click();
    await page.getByRole("menuitem", { name: /sign out/i }).click();
    await page.waitForURL(/\/signin/);
  });
});
