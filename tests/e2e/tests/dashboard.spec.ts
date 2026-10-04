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

test.describe("Phase 1.6 — Dashboard tiles", () => {
  test.beforeEach(async ({ page }) => {
    await signInAsTestUser(page);
    // Always start with the default layout so tests don't see leftovers.
    await page.evaluate(() =>
      fetch("/api/dashboard/layout", { method: "DELETE", credentials: "same-origin" }),
    );
    await page.goto("/");
  });

  test("default layout renders the default tiles", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    // DEFAULT_DASHBOARD_LAYOUT in packages/shared/src/schemas/dashboard.ts.
    // (checklists.my_open_tasks is module-gated, so it isn't asserted here.)
    for (const tileId of ["tickets.summary", "notes.recent", "wiki.recent", "monitoring.overview", "quick.links"]) {
      await expect(page.locator(`[data-tile-id="${tileId}"]`)).toBeVisible();
    }
  });

  test("customise mode reveals add/remove controls; removing a tile persists", async ({ page }) => {
    await page.getByRole("button", { name: "Customise" }).click();
    // 'Add tile' button now visible
    await expect(page.getByRole("button", { name: /add tile/i })).toBeVisible();

    // Remove the Quick links tile via its × button (aria-label "Remove Quick links")
    await page.getByRole("button", { name: "Remove Quick links" }).click();
    await expect(page.locator('[data-tile-id="quick.links"]')).toBeHidden();

    // Reload — the save should persist
    await page.waitForTimeout(1200); // debounce window
    await page.reload();
    await expect(page.locator('[data-tile-id="quick.links"]')).toBeHidden();
    await expect(page.locator('[data-tile-id="tickets.summary"]')).toBeVisible();
  });

  test("reset button restores the default layout", async ({ page }) => {
    // Custom layout via API: just one tile
    await page.evaluate(() =>
      fetch("/api/dashboard/layout", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          layout: [{ tileId: "notes.recent", x: 0, y: 0, w: 4, h: 3 }],
        }),
      }),
    );
    await page.reload();
    await expect(page.locator('[data-tile-id="quick.links"]')).toBeHidden();

    // Customise → Reset
    await page.getByRole("button", { name: "Customise" }).click();
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Reset" }).click();

    // Back to the default layout
    await expect(page.locator('[data-tile-id="quick.links"]')).toBeVisible();
    await expect(page.locator('[data-tile-id="tickets.summary"]')).toBeVisible();
  });
});
