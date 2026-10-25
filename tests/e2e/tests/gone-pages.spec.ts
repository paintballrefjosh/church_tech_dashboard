import { test, expect, type Page } from "@playwright/test";

// Links to a monitor, host or switch that was deleted (old notifications keep them) say so plainly instead of a
// bare 404. Nothing is created or changed.
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


const MISSING = "00000000-0000-4000-8000-00000000dead";

test.describe("Links to deleted things", () => {
  for (const [path, heading, back] of [
    [`/monitoring/${MISSING}`, "This monitor no longer exists", "Back to monitors"],
    [`/monitoring/infra/${MISSING}`, "This host no longer exists", "Infrastructure"],
    [`/monitoring/network-cisco/switches/${MISSING}`, "This switch no longer exists", "All switches"],
  ] as const) {
    test(`${path} says the thing was deleted`, async ({ page }) => {
      await signInAsTestUser(page);
      await page.goto(path);
      await expect(page.getByRole("heading", { name: heading })).toBeVisible();
      await expect(page.getByRole("link", { name: back })).toBeVisible();
    });
  }
});
