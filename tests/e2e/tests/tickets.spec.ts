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
  if (page.url().includes("/signin") || page.url().includes("/change-password")) {
    throw new Error(`signInAsTestUser: ended at ${page.url()}`);
  }
}

// Every ticket this suite creates is prefixed with this marker so the cleanup
// only touches its own rows — manual tickets on a dev DB survive a test run.
const E2E_PREFIX = "[e2e]";

async function wipeAllTickets(page: Page) {
  // Visit /tickets so same-origin fetch is reliable.
  await page.goto("/tickets?scope=all");
  const ids = (await page.evaluate(async (prefix) => {
    const r = await fetch("/api/tickets?scope=all", { credentials: "same-origin" });
    const list = (await r.json()) as Array<{ id: string; title: string }>;
    return list.filter((t) => t.title.startsWith(prefix)).map((t) => t.id);
  }, E2E_PREFIX)) as string[];
  for (const id of ids) {
    await page.evaluate(
      (i) => fetch(`/api/tickets/${i}`, { method: "DELETE", credentials: "same-origin" }),
      id,
    );
  }
}

test.describe("Phase 1.3 — Tickets", () => {
  test.beforeEach(async ({ page }) => {
    await signInAsTestUser(page);
    await wipeAllTickets(page);
  });

  test("Tickets link from the nav goes to /tickets", async ({ page }) => {
    await page.goto("/");
    // Tickets now lives inside the IT dropdown as "Help Desk". Open the menu
    // then click the menu item.
    await page.getByRole("button", { name: /^it$/i }).click();
    await page.getByRole("menuitem", { name: /help desk/i }).click();
    await page.waitForURL(/\/tickets(\?|$)/);
    await expect(page.getByRole("heading", { name: "Tickets" })).toBeVisible();
  });

  test("create a ticket, see it on the list, open it, change status, comment", async ({ page }) => {
    // Create
    await page.goto("/tickets/new");
    await page.getByLabel("Title").fill("[e2e] printer in foyer is jammed");
    await page.getByLabel("Description").fill("Won't feed paper. Tried restart.");
    await page.getByLabel("Priority").selectOption("high");
    await Promise.all([
      page.waitForURL(/\/tickets\/[0-9a-f-]+$/, { timeout: 15_000 }),
      page.getByRole("button", { name: /create ticket/i }).click(),
    ]);

    // Detail page renders
    await expect(page.getByRole("heading", { name: "Tickets" })).toHaveCount(0);
    await expect(page.getByLabel("Title")).toHaveValue("[e2e] printer in foyer is jammed");

    // Change status to in_progress via the sidebar dropdown
    await page.getByRole("combobox").first().selectOption("in_progress");
    // Wait for the patch to round-trip
    await expect(page.getByRole("combobox").first()).toHaveValue("in_progress");

    // Add a public comment
    await page.getByPlaceholder("Add a comment…").fill("Will check it after service.");
    await page.getByRole("button", { name: /^Comment$/ }).click();
    await expect(page.getByText("Will check it after service.")).toBeVisible();

    // Back to the list; the ticket appears with the in_progress badge
    await page.goto("/tickets");
    await expect(page.getByText("[e2e] printer in foyer is jammed")).toBeVisible();
    await expect(page.getByText("In progress").first()).toBeVisible();
  });

  test("admin/staff can post an internal comment that's flagged 'internal'", async ({ page }) => {
    // Create a ticket to attach the comment to.
    await page.goto("/tickets/new");
    await page.getByLabel("Title").fill("[e2e] internal comment test");
    await Promise.all([
      page.waitForURL(/\/tickets\/[0-9a-f-]+$/, { timeout: 15_000 }),
      page.getByRole("button", { name: /create ticket/i }).click(),
    ]);

    await page.getByPlaceholder("Add a comment…").fill("staff-only note");
    await page.getByLabel("Internal (staff only)").check();
    await page.getByRole("button", { name: /^Comment$/ }).click();
    await expect(page.getByText("staff-only note")).toBeVisible();
    await expect(page.getByText(/internal/i).first()).toBeVisible();
  });
});
