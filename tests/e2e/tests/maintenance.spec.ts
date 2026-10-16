import { test, expect, type Page } from "@playwright/test";

const TEST_USER = "regression-test@local";
const TEST_DEFAULT_PASSWORD = "regression-default-pwd";
const TEST_NEW_PASSWORD = "regression-changed-pwd-1";

// Runs after auth.spec.ts has changed the test user's default password. Always ends with maintenance mode off.
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

test.describe("Maintenance mode with an end time", () => {
  test.beforeEach(async ({ page }) => {
    await signInAsTestUser(page);
  });
  test.afterEach(async ({ page }) => {
    // Whatever happened, leave the site with alerts on.
    await page.request.post("/api/monitors/maintenance", { data: { enabled: false } });
  });

  test("pausing alerts asks how long, says when they resume, and resumes on demand", async ({ page }) => {
    await page.goto("/monitoring");
    const sw = page.getByRole("switch", { name: "Monitoring alerts enabled" });
    await expect(sw).toBeChecked();

    await sw.click();
    await expect(page.getByRole("menu", { name: "Pause alerts for" })).toBeVisible();
    await page.getByRole("menuitem", { name: "1 hour" }).click();
    await expect(page.getByText(/Maintenance, until \d/)).toBeVisible();
    await expect(sw).not.toBeChecked();

    // The server agrees, with an end time about an hour away.
    const reply = await (await page.request.get("/api/monitors/maintenance")).json();
    expect(reply.enabled).toBe(true);
    const mins = (Date.parse(reply.until) - Date.now()) / 60_000;
    expect(mins).toBeGreaterThan(55);
    expect(mins).toBeLessThan(61);

    // The time can be changed without turning alerts back on first.
    await page.getByRole("button", { name: "Change" }).click();
    await page.getByRole("menuitem", { name: "Until I turn it back on" }).click();
    await expect(page.getByText("Maintenance, no end time")).toBeVisible();

    await sw.click();
    await expect(sw).toBeChecked();
    await expect(page.getByText("Enabled", { exact: true })).toBeVisible();
    expect((await (await page.request.get("/api/monitors/maintenance")).json()).enabled).toBe(false);
  });
});
