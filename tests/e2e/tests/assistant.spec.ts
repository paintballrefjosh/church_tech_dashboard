import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const TEST_USER = "regression-test@local";
const TEST_DEFAULT_PASSWORD = "regression-default-pwd";
const TEST_NEW_PASSWORD = "regression-changed-pwd-1";

// Runs after 00-auth.spec.ts has changed the test user's default password. The assistant on the dev stack is not
// configured, so these check the panel, the palette entry and the usage page in their "not turned on" state. Nothing here
// ever asks a model: on a stack where it IS on, the question is never sent.
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

let page: Page;
let enabled = false;
test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext()).newPage();
  await signInAsTestUser(page);
  enabled = await page.evaluate(async () => ((await (await fetch("/api/v1/assistant/status", { credentials: "same-origin" })).json()) as { enabled: boolean }).enabled);
});
test.afterAll(async () => {
  await page.context().close();
});

const panel = () => page.getByTestId("assistant-panel");

test("the user menu opens the assistant as a panel, and Escape closes it", async () => {
  await page.goto("/tickets");
  // No button of its own: the top bar's right-hand side stays at two controls (it wrapped at 1280 px with a third).
  await expect(page.getByRole("button", { name: "Ask the assistant" })).toHaveCount(0);
  await page.locator('button[title="regression-test@local"]').click();
  await page.getByRole("menuitem", { name: "Ask the assistant" }).click();
  await expect(panel()).toBeVisible();
  await expect(panel().getByRole("heading", { name: "Assistant" })).toBeVisible();
  if (!enabled) await expect(panel().getByText("The assistant is not turned on.")).toBeVisible();
  await expect(panel().getByRole("link", { name: "Open full page" })).toHaveAttribute("href", "/assistant");
  const scan = await new AxeBuilder({ page }).include('[data-testid="assistant-panel"]').withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(scan.violations.map((v) => v.id)).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(panel()).toBeHidden();
});

test("the top bar stays on one line at 1280 px", async () => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  const brand = await page.locator('header a[href="/"]').first().boundingBox();
  const menu = await page.locator('button[title="regression-test@local"]').boundingBox();
  expect(brand && menu && Math.abs(brand.y + brand.height / 2 - (menu.y + menu.height / 2))).toBeLessThan(12);
});

test("the command palette keeps 'Ask the assistant' for a typed question and opens the panel", async () => {
  test.skip(enabled, "the assistant is on here: opening it with a question would ask the model");
  await page.goto("/");
  await page.locator("html[data-palette-ready]").waitFor({ state: "attached" });
  await page.keyboard.press("Control+k");
  const box = page.getByRole("dialog", { name: "Command palette" }).getByRole("combobox");
  await expect(box).toBeVisible();
  await box.fill("how many vlans are on the office switch");
  const entry = page.getByTestId("palette-act:assistant-ask");
  await expect(entry).toContainText("Ask the assistant: how many vlans are on the office switch");
  await entry.click();
  await expect(panel()).toBeVisible();
  await expect(panel().getByText("The assistant is not turned on.")).toBeVisible();
  await page.keyboard.press("Escape");
});

test("the usage page shows figures, never questions", async () => {
  await page.goto("/admin/assistant");
  await expect(page.getByRole("heading", { name: "Assistant usage" })).toBeVisible();
  await expect(page.getByText("Figures only: no question or answer is shown here.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Outcomes" })).toBeVisible();
});
