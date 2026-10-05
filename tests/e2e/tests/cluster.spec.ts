import { test, expect, type Page } from "@playwright/test";

const TEST_USER = "regression-test@local";
const TEST_DEFAULT_PASSWORD = "regression-default-pwd";
const TEST_NEW_PASSWORD = "regression-changed-pwd-1";

// After backups.spec.ts and before the specs that rely on the changed password; read-only.
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

test.describe("Cluster page", () => {
  test.beforeEach(async ({ page }) => {
    await signInAsTestUser(page);
  });

  test("the admin page links to Cluster, which shows this node live and leading jobs", async ({ page }) => {
    await page.goto("/admin");
    await page.getByRole("link", { name: "Cluster" }).click();
    await expect(page).toHaveURL(/\/admin\/cluster$/);
    await expect(page.getByRole("heading", { name: "Cluster", level: 1 })).toBeVisible();

    const nodes = page.getByTestId("cluster-nodes");
    const me = nodes.locator("tr", { hasText: "this node" });
    await expect(me).toBeVisible();
    await expect(me.getByText("live", { exact: true })).toBeVisible();
    await expect(page.getByTestId("cluster-jobs").locator("tr[data-job='backup-scheduler']")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Database" })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Object store \(/ })).toBeVisible();
    // A healthy dev stack has no problems listed.
    await expect(page.getByTestId("cluster-ok")).toBeVisible();
  });
});
