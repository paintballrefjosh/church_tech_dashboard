import { test, expect, type Page } from "@playwright/test";

const TEST_USER = "regression-test@local";
const TEST_DEFAULT_PASSWORD = "regression-default-pwd";
const TEST_NEW_PASSWORD = "regression-changed-pwd-1";

// Runs after auth.spec.ts has changed the test user's default password. Everything made here is prefixed and deleted again.
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

const PREFIX = "[e2e-hd]";

async function cleanup(page: Page) {
  await page.goto("/tickets?scope=all");
  await page.evaluate(async (prefix) => {
    const tickets = (await (await fetch("/api/tickets?scope=all", { credentials: "same-origin" })).json()) as Array<{ id: string; title: string }>;
    for (const t of tickets.filter((x) => x.title.startsWith(prefix))) await fetch(`/api/tickets/${t.id}`, { method: "DELETE", credentials: "same-origin" });
    const replies = (await (await fetch("/api/v1/tickets/canned-replies", { credentials: "same-origin" })).json()) as Array<{ id: string; title: string }>;
    for (const r of replies.filter((x) => x.title.startsWith(prefix))) await fetch(`/api/v1/tickets/canned-replies/${r.id}`, { method: "DELETE", credentials: "same-origin" });
  }, PREFIX);
}

async function newTicket(page: Page, title: string) {
  await page.goto("/tickets/new");
  await page.getByLabel("Title").fill(title);
  await Promise.all([page.waitForURL(/\/tickets\/[0-9a-f-]+$/, { timeout: 15_000 }), page.getByRole("button", { name: /create ticket/i }).click()]);
}

test.describe("Helpdesk: waiting on the requester, saved replies, mailbox settings", () => {
  test.beforeEach(async ({ page }) => {
    await signInAsTestUser(page);
    await cleanup(page);
  });
  test.afterEach(async ({ page }) => {
    await cleanup(page);
  });

  test("a ticket can wait on the requester, and their reply wakes it", async ({ page }) => {
    await newTicket(page, `${PREFIX} projector is dark`);
    await page.getByLabel("Status").selectOption("waiting");
    await expect(page.getByTestId("waiting-banner")).toBeVisible();
    // The test user owns the ticket, so the banner speaks to the requester (staff on someone else's ticket see the SLA wording).
    await expect(page.getByTestId("waiting-banner")).toContainText("We are waiting for your reply");

    await page.getByPlaceholder("Add a comment…").fill("It is the cable.");
    await page.getByRole("button", { name: /^Comment$/ }).click();
    await expect(page.getByText("It is the cable.")).toBeVisible();
    // The test user is both the requester and staff here, so their comment is the requester's reply.
    await expect(page.getByTestId("waiting-banner")).toHaveCount(0);
    await expect(page.getByLabel("Status")).toHaveValue("open");
  });

  test("waiting tickets are listed under the Waiting filter, and wait is not offered on one's own ticket", async ({ page }) => {
    await newTicket(page, `${PREFIX} wifi is slow`);
    // "Then wait for the requester" is for staff answering someone else's ticket; the test user owns this one.
    await expect(page.getByTestId("then-waiting")).toHaveCount(0);
    await page.getByLabel("Status").selectOption("waiting");
    await expect(page.getByLabel("Status")).toHaveValue("waiting");
    await page.goto("/tickets?status=waiting&scope=all");
    await expect(page.getByText(`${PREFIX} wifi is slow`)).toBeVisible();
    await expect(page.getByText("Waiting on requester").first()).toBeVisible();
  });

  test("saved replies: make one, then pick it in a ticket and see the details filled in", async ({ page }) => {
    await page.goto("/tickets/canned-replies");
    await page.getByTestId("canned-new").click();
    await page.getByTestId("canned-title").fill(`${PREFIX} restart it`);
    await page.getByTestId("canned-body").fill("Hi {{requester}}, about ticket #{{ticket_number}} ({{ticket_title}}): please restart it. -- {{agent}}");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByTestId("canned-list")).toContainText(`${PREFIX} restart it`);

    await newTicket(page, `${PREFIX} printer jam`);
    await page.getByTestId("canned-pick").selectOption({ label: `${PREFIX} restart it` });
    const box = page.getByPlaceholder("Add a comment…");
    await expect(box).toHaveValue(new RegExp(`\\(${PREFIX.replace(/[[\]]/g, "\\$&")} printer jam\\): please restart it`));
    await expect(box).not.toHaveValue(/\{\{ticket_number\}\}/);
    await expect(box).not.toHaveValue(/\{\{agent\}\}/);
    // The requester is the signed-in user here, but the people list is read-only for them in some set-ups, so it may stay a placeholder.
  });

  test("the helpdesk email settings page shows the mailbox is not set up", async ({ page }) => {
    await page.goto("/admin/settings/helpdesk");
    await expect(page.getByTestId("helpdesk-email-panel")).toBeVisible();
    await expect(page.getByTestId("inbound-state")).toContainText("Not set up yet");
    await expect(page.getByTestId("inbound-test")).toBeDisabled();
    await expect(page.getByText("Make tickets from email")).toBeVisible();
  });
});
