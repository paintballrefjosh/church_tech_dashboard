import { test, expect } from "@playwright/test";

const ADMIN_USERNAME = "admin";
const ADMIN_DEFAULT_PASSWORD = "admin";
// New password used after the forced password change. Each test sequence resets
// the admin back to admin/admin via `make reset-admin` before the suite runs.
const ADMIN_NEW_PASSWORD = "regression-test-pwd-1";

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

  test("default admin/admin sign-in lands on /change-password", async ({ page }) => {
    await page.goto("/signin");
    await page.getByLabel("Email or username").fill(ADMIN_USERNAME);
    await page.getByLabel("Password").fill(ADMIN_DEFAULT_PASSWORD);
    await Promise.all([
      page.waitForURL(/\/change-password/, { timeout: 15_000 }),
      page.getByRole("button", { name: "Sign in" }).click(),
    ]);
    await expect(page.getByRole("heading", { name: /set a new password/i })).toBeVisible();
  });

  test("changing the password signs out, then signing in with the new password reaches the dashboard", async ({ page }) => {
    // 1. default sign-in lands on /change-password
    await page.goto("/signin");
    await page.getByLabel("Email or username").fill(ADMIN_USERNAME);
    await page.getByLabel("Password").fill(ADMIN_DEFAULT_PASSWORD);
    await Promise.all([
      page.waitForURL(/\/change-password/, { timeout: 15_000 }),
      page.getByRole("button", { name: "Sign in" }).click(),
    ]);

    // 2. submit a new password — server clears the JWT and bounces to /signin?changed=1
    await page.getByLabel("New password").fill(ADMIN_NEW_PASSWORD);
    await page.getByLabel("Confirm password").fill(ADMIN_NEW_PASSWORD);
    await Promise.all([
      page.waitForURL(/\/signin/, { timeout: 15_000 }),
      page.getByRole("button", { name: /save new password/i }).click(),
    ]);

    // 3. signing in again with the new password gets us to the dashboard
    await page.getByLabel("Email or username").fill(ADMIN_USERNAME);
    await page.getByLabel("Password").fill(ADMIN_NEW_PASSWORD);
    await Promise.all([
      page.waitForURL((url) => url.pathname === "/", { timeout: 15_000 }),
      page.getByRole("button", { name: "Sign in" }).click(),
    ]);
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  });

  test("sign-out returns to /signin", async ({ page }) => {
    // Signed in via the previous test; cookies persist within the test file
    // because the context is reused in serial mode unless reset.
    await page.goto("/signin");
    await page.getByLabel("Email or username").fill(ADMIN_USERNAME);
    await page.getByLabel("Password").fill(ADMIN_NEW_PASSWORD);
    await Promise.all([
      page.waitForURL((url) => url.pathname === "/", { timeout: 15_000 }),
      page.getByRole("button", { name: "Sign in" }).click(),
    ]);
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL(/\/signin/);
  });
});
