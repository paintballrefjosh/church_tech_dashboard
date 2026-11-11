import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Signage in the browser (docs/signage.md). Makes a screen with no Pi and no TV control, a group and an empty playlist
// through the API, walks every page of the module (settings included: they live under /signage, not Admin), opens the
// forms, runs axe, and removes what it made. Nothing reaches a Pi or a TV: no device is set up and nothing is scanned.
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

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

const STAMP = Date.now();
const SCREEN = `[e2e] Foyer ${STAMP}`;
const GROUP = `[e2e] Lobby ${STAMP}`;
const PLAYLIST = `[e2e] Welcome ${STAMP}`;

test("signage: every page of the module, its forms and its own settings pages", async ({ page }) => {
  test.setTimeout(120_000);
  await signInAsTestUser(page);
  const api = page.request;
  const me = await (await api.get("/api/me")).json().catch(() => null);
  test.skip(!!me && Array.isArray(me.permissions) && !me.permissions.includes("signage:admin"), "the regression account is not a Signage admin here");

  const made: Array<string> = [];
  const group = await (await api.post("/api/signage/groups", { data: { name: GROUP } })).json();
  made.push(`groups/${group.id}`);
  const playlist = await (await api.post("/api/signage/playlists", { data: { name: PLAYLIST } })).json();
  const screenRes = await api.post("/api/signage/screens", { data: { name: SCREEN, groupIds: [group.id], fallbackPlaylistId: playlist.id } });
  expect(screenRes.status()).toBeLessThan(300);
  const screen = await screenRes.json();
  made.unshift(`screens/${screen.id}`);
  made.push(`playlists/${playlist.id}`);
  try {
    // Screens: the tile, then the screen's page with its "why" and its week.
    await page.goto("/signage");
    await expect(page.getByRole("navigation", { name: "Signage" })).toBeVisible();
    await expect(page.getByRole("link", { name: SCREEN, exact: true })).toBeVisible();
    await axe(page);
    await page.getByRole("button", { name: /add a screen/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await axe(page);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.getByRole("link", { name: SCREEN, exact: true }).click();
    await page.waitForURL(`**/signage/screens/${screen.id}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(SCREEN);
    // Its only rule is an empty fallback playlist: the "why" says so instead of claiming there is no fallback.
    await expect(page.getByText(/every rule that applies has nothing to play/i)).toBeVisible();
    await axe(page);

    // Schedule: a month calendar by default; the add form offers the group and the screen, one time or repeating.
    await page.goto("/signage/schedules");
    await expect(page.getByRole("button", { name: "Month" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: /^today$/i })).toBeVisible();
    await axe(page);
    await page.getByRole("button", { name: /add to the schedule/i }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("option", { name: new RegExp(GROUP.replace(/[[\]]/g, "\\$&")) })).toHaveCount(1);
    await expect(dialog.getByLabel("Priority")).toHaveValue("3");
    await dialog.getByText("Repeats", { exact: true }).click();
    await dialog.getByLabel("Repeat", { exact: true }).selectOption("monthly");
    await expect(dialog.getByRole("group", { name: /weeks of the month/i })).toBeVisible();
    await axe(page);
    await page.keyboard.press("Escape");

    // The "notice on every screen" form is a one-time entry on All screens, Highest, with TVs switched on.
    await page.getByRole("button", { name: /notice on every screen/i }).click();
    await expect(page.getByRole("dialog").getByLabel("Screens", { exact: true })).toHaveValue("all");
    await expect(page.getByRole("dialog").getByLabel("Priority")).toHaveValue("5");
    await expect(page.getByRole("dialog").getByLabel(/switch the tvs on/i)).toBeChecked();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "List" }).click();
    await expect(page.getByRole("region", { name: /every schedule entry/i })).toBeVisible();
    await axe(page);
    await page.getByRole("button", { name: "Month" }).click();

    // The old Events address lands on the Schedule.
    await page.goto("/signage/events");
    await page.waitForURL("**/signage/schedules");

    await page.goto("/signage/playlists");
    await page.getByRole("link", { name: PLAYLIST, exact: true }).click();
    await page.waitForURL(`**/signage/playlists/${playlist.id}`);
    await axe(page);

    for (const path of ["/signage/media", "/signage/power"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await axe(page);
    }

    // Devices: the tabs, and the Find Pis discovery form (nothing is scanned).
    await page.goto("/signage/devices?tab=found");
    await expect(page.getByRole("tab", { name: /found/i })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByLabel("Subnet")).toBeVisible();
    await axe(page);
    await page.getByRole("tab", { name: /^all/i }).click();
    await expect(page).toHaveURL(/tab=all/);
    // Discovery is on the page, not only on the Found tab: a Find Pis button shows and hides it whatever tab is open.
    const subnet = page.getByLabel("Subnet");
    if (await subnet.isVisible()) await page.getByRole("button", { name: "Find Pis" }).click();
    await expect(subnet).toBeHidden();
    await page.getByRole("button", { name: "Find Pis" }).click();
    await expect(subnet).toBeVisible();
    await expect(page.getByLabel("Or add addresses")).toBeVisible();
    await axe(page);

    // Settings live in the module, and the saved setup password never reaches the page.
    await page.goto("/signage/settings");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Signage settings");
    await expect(page.getByText(/ssh-ed25519 /)).toBeVisible();
    await axe(page);
    await page.getByRole("link", { name: "Security settings" }).click();
    await page.waitForURL("**/signage/security");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Security settings");
    await axe(page);
    // Never changes the saved password: reads it (an admin gets it from the API) and checks this page does not carry it.
    const saved = await api.get("/api/v1/settings/signage.setup_password");
    const value = saved.ok() ? ((await saved.json()) as { value?: unknown }).value : null;
    const html = await page.content();
    if (typeof value === "string" && value.length >= 4 && value !== "********") expect(html.includes(value)).toBe(false);
    expect(html).not.toMatch(/PRIVATE KEY/);
  } finally {
    for (const p of made) await api.delete(`/api/signage/${p}`, { timeout: 15_000 }).catch(() => undefined);
  }
});
