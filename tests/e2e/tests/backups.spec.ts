import { test, expect, type Page } from "@playwright/test";

const TEST_USER = "regression-test@local";
const TEST_DEFAULT_PASSWORD = "regression-default-pwd";
const TEST_NEW_PASSWORD = "regression-changed-pwd-1";

// Runs after auth.spec.ts (which needs the test user's default password) and before the specs
// that sign in with the changed one. It never presses the final Restore button: a restore rewinds
// the live data every other spec uses; restores are covered by the engine's integration tests and
// the throwaway-cluster test (tests/cluster/backup-restore.sh).
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

const stamp = Date.now();
const backupName = `e2e backup ${stamp}`;
const scheduleName = `e2e schedule ${stamp}`;

test.describe("Backups", () => {
  test.beforeEach(async ({ page }) => {
    await signInAsTestUser(page);
    page.on("dialog", (d) => void d.accept());
  });

  test("the admin page links to Backups", async ({ page }) => {
    await page.goto("/admin");
    await page.getByRole("link", { name: "Backups" }).click();
    await expect(page).toHaveURL(/\/admin\/backups$/);
    await expect(page.getByRole("heading", { name: "Backups", level: 1 })).toBeVisible();
    for (const tab of ["Backups", "Schedules", "Restore"]) {
      await expect(page.getByRole("navigation", { name: "Backup sections" }).getByRole("link", { name: tab })).toBeVisible();
    }
  });

  test("create a backup, see it listed, download it", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/admin/backups");
    await page.getByPlaceholder(/Before the Easter changes/).fill(backupName);
    await page.getByLabel("Include uploaded files").uncheck();
    await page.getByRole("button", { name: "Create backup" }).click();
    const row = page.getByTestId("backup-table").locator("tr", { hasText: backupName });
    await expect(row).toBeVisible({ timeout: 90_000 });
    await expect(row.getByText("Manual")).toBeVisible();
    await expect(row.getByRole("button", { name: /Download/ })).toBeVisible({ timeout: 90_000 });

    const [download] = await Promise.all([page.waitForEvent("download"), row.getByRole("button", { name: /Download/ }).click()]);
    expect(download.suggestedFilename()).toMatch(/\.tar\.gz$/);
  });

  test("a schedule can be created, paused, resumed and deleted", async ({ page }) => {
    await page.goto("/admin/backups?tab=schedules");
    await page.getByRole("button", { name: "New schedule" }).click();
    const form = page.getByTestId("schedule-form");
    await form.locator("[name=name]").fill(scheduleName);
    await form.locator("[name=frequency]").selectOption("weekly");
    await form.locator("[name=dayOfWeek]").selectOption("0");
    await form.locator("[name=time]").fill("03:00");
    await form.locator("[name=keep]").fill("3");
    await expect(form.getByText(/Every Sunday at 03:00/)).toBeVisible();
    await form.getByRole("button", { name: "Create schedule" }).click();

    const card = page.locator("li", { hasText: scheduleName });
    await expect(card).toBeVisible();
    await expect(card.getByText(/Every Sunday at 03:00/)).toBeVisible();
    await expect(card.getByText(/Next:/)).toBeVisible();

    await card.getByRole("button", { name: "Pause" }).click();
    await expect(card.getByText("Paused", { exact: true })).toBeVisible();
    await expect(card.getByText(/Not scheduled while paused/)).toBeVisible();
    await card.getByRole("button", { name: "Resume" }).click();
    await expect(card.getByText(/Next:/)).toBeVisible();

    await card.getByRole("button", { name: "Delete" }).click();
    await expect(page.locator("li", { hasText: scheduleName })).toHaveCount(0);
  });

  test("restore: choose a backup, compare, and the Restore button stays locked until it is confirmed", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/admin/backups?tab=restore");
    await page.getByRole("radiogroup", { name: "Backups" }).locator("label", { hasText: backupName }).click();
    await page.getByRole("button", { name: /Compare with the current data/ }).click();
    const report = page.getByTestId("diff-report");
    await expect(report).toBeVisible({ timeout: 90_000 });
    await expect(report.getByText("Brought back", { exact: true })).toBeVisible();
    await expect(report.getByText("Already identical")).toBeVisible();
    await expect(page.getByTestId("diff-files")).toHaveCount(0); // made without files

    const button = page.getByTestId("restore-button");
    await expect(button).toBeDisabled();
    await page.getByTestId("restore-phrase").fill("restore");
    await expect(button).toBeDisabled(); // case matters
    await page.getByTestId("restore-phrase").fill("RESTORE");
    await expect(button).toBeEnabled();
    await page.getByTestId("restore-phrase").fill("");
    await expect(button).toBeDisabled();
  });

  test("restore: choose which sections to restore; a changed selection locks the button until it is compared again", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/admin/backups?tab=restore");
    await page.getByRole("radiogroup", { name: "Backups" }).locator("label", { hasText: backupName }).click();
    const picker = page.getByTestId("section-picker");
    await expect(picker).toBeVisible();
    // Everything is chosen to start with; keep only the wiki.
    await expect(page.getByTestId("section-wiki")).toBeChecked();
    await picker.getByRole("button", { name: "Select nothing" }).click();
    await page.getByTestId("section-wiki").check();
    await page.getByRole("button", { name: /Compare the chosen sections/ }).click();
    const report = page.getByTestId("diff-report");
    await expect(report).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId("scope-note")).toBeVisible();
    await expect(page.getByRole("button", { name: "Restore the chosen sections" })).toBeVisible();

    // With the phrase typed the button is live ...
    await page.getByTestId("restore-phrase").fill("RESTORE");
    const button = page.getByTestId("restore-button");
    await expect(button).toBeEnabled();
    // ... until the selection changes: the report no longer describes what would be restored.
    await page.getByTestId("section-notes").check();
    await expect(page.getByTestId("stale-report")).toBeVisible();
    await expect(button).toBeDisabled();
    // Choosing nothing cannot be compared.
    await picker.getByRole("button", { name: "Select nothing" }).click();
    await expect(page.getByRole("button", { name: /Compare the chosen sections|Compare with the current data/ })).toBeDisabled();
  });

  test("a bad file is refused on upload with a reason", async ({ page }) => {
    await page.goto("/admin/backups?tab=restore");
    await page.getByTestId("backup-file-input").setInputFiles({ name: "notes.tar.gz", mimeType: "application/gzip", buffer: Buffer.from("this is not a backup") });
    await expect(page.getByText(/not a backup file/i)).toBeVisible();
  });

  test("rename and delete the backup this spec made", async ({ page }) => {
    await page.goto("/admin/backups");
    const found = page.getByTestId("backup-table").locator("tr", { hasText: backupName });
    const id = await found.getAttribute("data-backup-id");
    // The name moves into an input while it is being edited, so find the row by its id from here on.
    const row = page.locator(`tr[data-backup-id="${id}"]`);
    await row.getByRole("button", { name: `Rename ${backupName}` }).click();
    await row.getByRole("textbox").fill(`${backupName} renamed`);
    await row.getByRole("button", { name: "Save" }).click();
    await expect(row.getByText(`${backupName} renamed`)).toBeVisible();
    await row.getByRole("button", { name: /^Delete/ }).click();
    await expect(page.locator(`tr[data-backup-id="${id}"]`)).toHaveCount(0);
  });
});
