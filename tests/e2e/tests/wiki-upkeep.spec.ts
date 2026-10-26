import { test, expect, type Page } from "@playwright/test";

const TEST_USER = "regression-test@local";
const TEST_DEFAULT_PASSWORD = "regression-default-pwd";
const TEST_NEW_PASSWORD = "regression-changed-pwd-1";

// Runs after 00-auth.spec.ts has changed the test user's default password. Everything made here is prefixed and deleted again.
// What makes a page due for review is time, so that is covered by the integration test, not here.
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

const PREFIX = "[e2e-wk]";

async function cleanup(page: Page) {
  await page.goto("/wiki");
  await page.evaluate(async (prefix) => {
    const pages = (await (await fetch("/api/v1/wiki?limit=200", { credentials: "same-origin" })).json()) as Array<{ id: string; title: string }>;
    for (const p of pages.filter((x) => x.title.startsWith(prefix))) await fetch(`/api/v1/wiki/${p.id}`, { method: "DELETE", credentials: "same-origin" });
    const tpls = (await (await fetch("/api/v1/wiki/templates", { credentials: "same-origin" })).json()) as Array<{ id: string; name: string }>;
    for (const t of tpls.filter((x) => x.name.startsWith(prefix))) await fetch(`/api/v1/wiki/templates/${t.id}`, { method: "DELETE", credentials: "same-origin" });
  }, PREFIX);
}

/** Make a page through the API (fast, and the editor is not what is being tested here). */
async function apiPage(page: Page, title: string, body: string): Promise<string> {
  return page.evaluate(
    async ({ title, body }) => {
      const r = await fetch("/api/v1/wiki", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, body, visibility: "public" }),
      });
      return ((await r.json()) as { id: string }).id;
    },
    { title, body },
  );
}

async function apiEdit(page: Page, id: string, patch: Record<string, unknown>) {
  await page.evaluate(
    async ({ id, patch }) => {
      await fetch(`/api/v1/wiki/${id}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
    },
    { id, patch },
  );
}

test.describe("Wiki: templates, linked-from, confirming a page, history", () => {
  test.beforeEach(async ({ page }) => {
    await signInAsTestUser(page);
    await cleanup(page);
  });
  test.afterEach(async ({ page }) => {
    await cleanup(page);
  });

  test("a new page can start from a built-in template, with the date and author filled in", async ({ page }) => {
    await page.goto("/wiki/new");
    await page.getByTestId("template-pick").selectOption({ label: "Runbook" });
    const editor = page.getByRole("textbox", { name: "Body" });
    await expect(editor.getByRole("heading", { name: "Escalate" })).toBeVisible();
    await expect(editor).not.toContainText("{{");
    await expect(editor).toContainText(/\d{4}-\d{2}-\d{2}/);
    await page.getByLabel("Title").fill(`${PREFIX} Printer runbook`);
    await Promise.all([page.waitForURL(/\/wiki\/[0-9a-f-]{36}$/, { timeout: 15_000 }), page.getByRole("button", { name: /create page/i }).click()]);
    await expect(page.getByRole("heading", { name: `${PREFIX} Printer runbook` })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Symptoms" })).toBeVisible();
  });

  test("?template= opens the new page screen with that template chosen", async ({ page }) => {
    await page.goto("/wiki/new?template=starter:how-to");
    await expect(page.getByTestId("template-pick")).toHaveValue("starter:how-to");
    await expect(page.getByRole("textbox", { name: "Body" }).getByRole("heading", { name: "Steps" })).toBeVisible();
  });

  test("an admin saves a template, it is offered on the new page screen, and deleting it removes it", async ({ page }) => {
    await page.goto("/wiki/templates");
    await expect(page.getByRole("heading", { name: "Page templates" })).toBeVisible();
    await page.getByTestId("template-new").click();
    await page.getByTestId("template-name").fill(`${PREFIX} Volunteer onboarding`);
    await page.getByTestId("template-description").fill("what a new volunteer needs");
    await page.getByRole("textbox", { name: "Template outline" }).click();
    await page.keyboard.type("Welcome aboard");
    await page.getByTestId("template-save").click();
    await expect(page.getByTestId("template-row").filter({ hasText: `${PREFIX} Volunteer onboarding` })).toBeVisible();

    await page.goto("/wiki/new");
    await expect(page.getByTestId("template-pick").locator("option", { hasText: `${PREFIX} Volunteer onboarding` })).toHaveCount(1);
    await page.getByTestId("template-pick").selectOption({ label: `${PREFIX} Volunteer onboarding` });
    await expect(page.getByRole("textbox", { name: "Body" })).toContainText("Welcome aboard");

    await page.goto("/wiki/templates");
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: `Delete ${PREFIX} Volunteer onboarding` }).click();
    await expect(page.getByTestId("template-row").filter({ hasText: `${PREFIX} Volunteer onboarding` })).toHaveCount(0);
  });

  test("a link made with the page picker shows up under 'Linked from' on the page it points to", async ({ page }) => {
    const target = await apiPage(page, `${PREFIX} Core switch`, "Ports and VLANs.");
    const other = await apiPage(page, `${PREFIX} Network overview`, "Start here.");
    await page.goto(`/wiki/${other}/edit`);
    await page.getByRole("textbox", { name: "Body" }).click();
    await page.keyboard.press("Control+End");
    await page.getByRole("button", { name: "Link to a wiki page" }).click();
    const dialog = page.getByRole("dialog", { name: "Link to a wiki page" });
    await dialog.getByLabel("Search pages by title").fill("Core switch");
    await dialog.getByRole("option", { name: `${PREFIX} Core switch` }).getByRole("button").click();
    await expect(page.getByRole("textbox", { name: "Body" }).getByRole("link", { name: `${PREFIX} Core switch` })).toBeVisible();
    await Promise.all([page.waitForURL(`**/wiki/${other}`, { timeout: 15_000 }), page.getByRole("button", { name: /save changes/i }).click()]);

    await page.goto(`/wiki/${target}`);
    const linked = page.getByTestId("backlinks");
    await expect(linked).toBeVisible();
    await expect(linked.getByRole("link", { name: `${PREFIX} Network overview` })).toBeVisible();
    await expect(page.getByTestId("backlinks").getByText("Start here")).toBeVisible();

    // A page nobody links to has no such section.
    await page.goto(`/wiki/${other}`);
    await expect(page.getByTestId("backlinks")).toHaveCount(0);
  });

  test("confirming a page records it, and the owner can choose how often it is checked", async ({ page }) => {
    const id = await apiPage(page, `${PREFIX} Wifi passwords`, "Where they live.");
    await page.goto(`/wiki/${id}`);
    await expect(page.getByTestId("review-banner")).toHaveCount(0);
    await expect(page.getByTestId("review-line")).toContainText("Not confirmed by anyone yet");
    await page.getByTestId("review-confirm").click();
    await expect(page.getByTestId("review-line")).toContainText("Confirmed correct");
    await expect(page.getByTestId("review-line")).toContainText("next check due");

    await page.goto(`/wiki/${id}/edit`);
    await page.getByTestId("review-interval").selectOption({ label: "Never (does not go out of date)" });
    await Promise.all([page.waitForURL(`**/wiki/${id}`, { timeout: 15_000 }), page.getByRole("button", { name: /save changes/i }).click()]);
    await expect(page.getByTestId("review-line")).toContainText("not checked on a schedule");
  });

  test("the to-review list opens and says so when nothing is due", async ({ page }) => {
    await page.goto("/wiki");
    await page.getByTestId("wiki-review-link").click();
    await expect(page).toHaveURL(/\/wiki\/review$/);
    await expect(page.getByRole("heading", { name: "Pages to review" })).toBeVisible();
    await expect(page.getByTestId("review-total")).toBeVisible();
    await page.getByRole("link", { name: "Mine" }).click();
    await expect(page).toHaveURL(/scope=mine/);
  });

  test("history shows what an edit changed, down to the words, and compares any two versions", async ({ page }) => {
    const id = await apiPage(page, `${PREFIX} Restart steps`, "Restart the router now.\nWait two minutes.\nDone.");
    await apiEdit(page, id, { body: "Restart the switch now.\nWait two minutes.\nDone.", summary: "router is a switch" });
    await apiEdit(page, id, { title: `${PREFIX} Restart steps v2`, body: "Restart the switch now.\nWait five minutes.\nDone.\nCall Sam." });

    await page.goto(`/wiki/${id}/revisions`);
    const items = page.getByTestId("revision-item");
    await expect(items).toHaveCount(3);
    // The newest edit against the one before it: a title change, one changed word, one added line.
    await expect(page.getByTestId("diff-title")).toContainText(`${PREFIX} Restart steps v2`);
    await expect(page.getByTestId("diff-stats")).toHaveText("2 added, 1 removed");
    const body = page.getByTestId("diff-body");
    await expect(body.locator('[data-diff="add"]')).toHaveCount(2);
    await expect(body.locator('[data-diff="add"] span.rounded-sm', { hasText: "five" })).toBeVisible();
    await expect(body.locator('[data-diff="remove"] span.rounded-sm', { hasText: "two" })).toBeVisible();

    // The edit before that.
    await items.nth(1).click();
    await expect(page.getByTestId("diff-stats")).toHaveText("1 added, 1 removed");
    await expect(page.getByTestId("diff-body").locator('[data-diff="add"] span.rounded-sm', { hasText: "switch" })).toBeVisible();

    // The first version against the page as it is now.
    await items.nth(2).click();
    await page.getByTestId("diff-from").selectOption({ index: 3 });
    await page.getByTestId("diff-to").selectOption({ index: 0 });
    await expect(page.getByTestId("diff-stats")).not.toHaveText("no difference");
    await page.getByRole("tab", { name: "This version" }).click();
    await expect(page.getByTestId("version-text")).toContainText("Restart the switch now.");
  });

  test("restoring an old version brings its text back as a new revision", async ({ page }) => {
    const id = await apiPage(page, `${PREFIX} Door codes`, "original text");
    await apiEdit(page, id, { body: "changed text" });
    await page.goto(`/wiki/${id}/revisions`);
    await page.getByTestId("revision-item").nth(1).click();
    await page.getByTestId("diff-to").selectOption({ index: 2 });
    page.once("dialog", (d) => void d.accept());
    await Promise.all([page.waitForURL(`**/wiki/${id}`, { timeout: 15_000 }), page.getByTestId("restore").click()]);
    await expect(page.getByText("original text")).toBeVisible();
  });
});
