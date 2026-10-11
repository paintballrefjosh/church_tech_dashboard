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

async function readSections(page: Page): Promise<Record<string, string[]>> {
  return page.evaluate(async () => {
    const r = await fetch("/api/dashboard/prefs", { credentials: "same-origin" });
    const j = (await r.json()) as { sections?: Record<string, string[]> };
    return j.sections ?? {};
  });
}

async function writeSections(page: Page, sections: Record<string, string[]>): Promise<number> {
  return page.evaluate(async (s) => {
    const r = await fetch("/api/dashboard/prefs", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sections: s }),
    });
    return r.status;
  }, sections);
}

test.describe("Home look: hiding sections", () => {
  let original: Record<string, string[]> = {};

  test.beforeEach(async ({ page }) => {
    await signInAsTestUser(page);
    await page.goto("/?theme=start");
    original = await readSections(page);
  });

  test("a hidden section of the start look is left out, and comes back when restored", async ({ page }) => {
    try {
      await page.goto("/?theme=start");
      await expect(page.getByRole("heading", { name: "Needs you" })).toBeVisible();

      expect(await writeSections(page, { ...original, start: ["needs"] })).toBe(200);
      await page.goto("/?theme=start");
      await expect(page.locator('[data-look="start"]')).toBeVisible();
      await expect(page.getByRole("heading", { name: "Needs you" })).toHaveCount(0);
      // The greeting (the look's signature) is never optional.
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    } finally {
      await writeSections(page, original);
    }
    await page.goto("/?theme=start");
    await expect(page.getByRole("heading", { name: "Needs you" })).toBeVisible();
  });

  test("unknown section ids are dropped by the API", async ({ page }) => {
    try {
      expect(await writeSections(page, { ...original, start: ["recent", "not-a-section"] })).toBe(200);
      const saved = await readSections(page);
      expect(saved.start).toEqual(["recent"]);
    } finally {
      await writeSections(page, original);
    }
  });

  test("the picker offers a checkbox per section of the current look", async ({ page }) => {
    await page.goto("/?theme=start");
    await page.getByTestId("look-picker-open").click();
    const group = page.getByTestId("look-sections");
    await expect(group).toBeVisible();
    await expect(group.getByRole("checkbox", { name: "Show needs you" })).toBeChecked();
  });
});
