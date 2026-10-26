import { test, expect, type Page } from "@playwright/test";

const TEST_USER = "regression-test@local";
const TEST_DEFAULT_PASSWORD = "regression-default-pwd";
const TEST_NEW_PASSWORD = "regression-changed-pwd-1";

// Runs after 00-auth.spec.ts has changed the test user's default password. The monitor made here points at a closed port on
// the probe worker's own host and is deleted at the end, whatever happens.
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

const stamp = Date.now();
const plainName = `E2E Printing ${stamp}`;

test.describe("Status page and acknowledging an incident", () => {
  let monitorId = "";

  test.beforeEach(async ({ page }) => {
    await signInAsTestUser(page);
  });
  test.afterAll(async ({ browser }) => {
    if (!monitorId) return;
    const page = await browser.newPage();
    await signInAsTestUser(page);
    await page.request.delete(`/api/monitors/${monitorId}`);
    await page.close();
  });

  test("the monitor form offers the status page options", async ({ page }) => {
    await page.goto("/monitoring/new");
    const show = page.getByLabel(/Show on the status page/);
    await expect(show).not.toBeChecked();
    await expect(page.getByLabel("Name on the status page")).toHaveCount(0);
    await show.check();
    await expect(page.getByLabel("Name on the status page")).toBeVisible();
  });

  test("a listed service shows under its plain name; acknowledging its incident shows on the page", async ({ page }) => {
    const created = await page.request.post("/api/monitors", {
      data: {
        name: `e2e status ${stamp}`,
        kind: "tcp",
        target: "127.0.0.1:9",
        intervalSec: 10,
        failThreshold: 1,
        recoverThreshold: 1,
        showOnStatus: true,
        statusName: plainName,
        // It goes down on purpose: alerts off, or every run would notify the real monitoring recipients.
        options: { alerts: false },
      },
    });
    expect(created.ok()).toBe(true);
    monitorId = (await created.json()).id;

    // The first failed check opens an incident.
    await expect
      .poll(async () => ((await (await page.request.get(`/api/monitors/${monitorId}/incidents`)).json()) as unknown[]).length, { timeout: 90_000, intervals: [2_000] })
      .toBeGreaterThan(0);

    await page.goto("/status");
    await expect(page.getByRole("heading", { level: 1, name: "Status" })).toBeVisible();
    const row = page.getByTestId("status-list").getByRole("listitem").filter({ hasText: plainName });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Down");
    await expect(page.getByTestId("status-overall")).toHaveAttribute("data-overall", /outage|degraded/);
    // Plain words only: not the address, not the error.
    await expect(page.getByTestId("status-list")).not.toContainText("127.0.0.1");
    await expect(row).not.toContainText("Someone is looking into it");

    await page.goto(`/monitoring/${monitorId}`);
    await page.getByTestId("ack-incident").click();
    await expect(page.getByText(/acknowledged/).first()).toBeVisible();
    await expect(page.getByTestId("ack-incident")).toHaveCount(0);

    await page.goto("/status");
    await expect(page.getByTestId("status-list").getByRole("listitem").filter({ hasText: plainName })).toContainText("Someone is looking into it");
  });

  test("the status page is one click from the user menu", async ({ page }) => {
    await page.goto("/");
    await page.locator('button[aria-haspopup="menu"]').filter({ hasText: TEST_USER }).click();
    await page.getByRole("menuitem", { name: "Status" }).click();
    await expect(page).toHaveURL(/\/status$/);
  });
});
