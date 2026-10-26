import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Livestreams in the browser (docs/livestreams.md). Makes one SWITCHED-OFF stream through the API (so nothing ever reads a
// real stream), walks the wall, the stream's page and its edit form, runs axe on both pages, and removes the stream.
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
      await Promise.all([page.waitForURL(/\/signin/, { timeout: 15_000 }), page.getByRole("button", { name: /save new password/i }).click()]);
      await attempt(TEST_NEW_PASSWORD);
    }
  }
}

const NAME = `[e2e] Sunday stream ${Date.now()}`;

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

test("livestreams: the wall, a stream's page and its form, for a switched-off stream", async ({ page }) => {
  await signInAsTestUser(page);
  const api = page.request;
  const res = await api.post("/api/livestreams", {
    data: { name: NAME, platform: "resi", access: "private", pageUrl: "", streamUrl: "https://cdn.example.invalid/live/index.m3u8?token=e2e", schedule: "Sun 10:15-12:15", enabled: false },
  });
  expect(res.status()).toBeLessThan(300);
  const s = await res.json();
  try {
    expect(s.hasStreamUrl).toBe(true);
    expect(JSON.stringify(s)).not.toContain("token=e2e");

    await page.goto("/livestreams");
    const tile = page.getByRole("listitem").filter({ hasText: NAME });
    await expect(tile).toBeVisible();
    await expect(tile).toContainText("Switched off");
    await expect(tile).toContainText("Resi (private)");
    await axe(page);

    await tile.getByRole("link", { name: NAME, exact: true }).click();
    await page.waitForURL(`**/livestreams/${s.id}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(NAME);
    await expect(page.getByText("A private link (saved, not shown)")).toBeVisible();
    await expect(page.getByText("Sun 10:15-12:15 (after 5 minutes)")).toBeVisible();
    await axe(page);

    // Check now refuses a switched-off stream and says so.
    await page.getByRole("button", { name: "Check now" }).click();
    await expect(page.getByText(/switched off/i).last()).toBeVisible();

    await page.getByRole("button", { name: "Edit" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Platform")).toHaveValue("resi");
    await expect(dialog.getByLabel(/Private link/)).toHaveValue("");
    await expect(dialog.getByLabel(/Private link/)).toHaveAttribute("placeholder", /A link is saved/);
    await dialog.getByLabel("Name").fill(`${NAME} edited`);
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("edited");
    const after = await (await api.get(`/api/livestreams/${s.id}`)).json();
    expect(after.hasStreamUrl).toBe(true);
  } finally {
    await api.delete(`/api/livestreams/${s.id}`);
  }
});
