import { test, expect, type BrowserContext, type Page } from "@playwright/test";

const TEST_USER = "regression-test@local";
const TEST_DEFAULT_PASSWORD = "regression-default-pwd";
const TEST_NEW_PASSWORD = "regression-changed-pwd-1";

// Runs after 00-auth.spec.ts has changed the test user's default password. The command palette's actions: what it lists is
// covered by apps/web/src/lib/palette.test.ts (who sees what); here the real routes are used. Everything made is deleted
// and alert pausing is put back.
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



const PREFIX = "[e2e-pal]";

let context: BrowserContext;
let page: Page;
test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  page = await context.newPage();
  await signInAsTestUser(page);
});
test.afterAll(async () => {
  await page.goto("/");
  await page.evaluate(async (prefix) => {
    const j = { "content-type": "application/json" };
    await fetch("/api/v1/monitors/maintenance", { method: "POST", credentials: "same-origin", headers: j, body: JSON.stringify({ enabled: false }) });
    const tickets = (await (await fetch("/api/v1/tickets?scope=all&limit=200", { credentials: "same-origin" })).json()) as Array<{ id: string; title: string }>;
    for (const t of tickets.filter((x) => x.title.startsWith(prefix))) await fetch(`/api/v1/tickets/${t.id}`, { method: "DELETE", credentials: "same-origin" });
    const pages = (await (await fetch("/api/v1/wiki?limit=200", { credentials: "same-origin" })).json()) as Array<{ id: string; title: string }>;
    for (const p of pages.filter((x) => x.title.startsWith(prefix))) await fetch(`/api/v1/wiki/${p.id}`, { method: "DELETE", credentials: "same-origin" });
  }, PREFIX);
  await context.close();
});

const palette = () => page.getByRole("dialog", { name: "Command palette" });
async function openPalette() {
  // The keystroke is only heard once the page has loaded in the browser.
  await page.locator("html[data-palette-ready]").waitFor({ state: "attached" });
  await page.keyboard.press("Control+k");
  // The dialog wrapper itself has no size (its children are positioned), so look at the search box.
  await expect(palette().getByRole("combobox")).toBeVisible();
}
async function run(query: string, testId: string) {
  await openPalette();
  await palette().getByRole("combobox").fill(query);
  await palette().getByTestId(testId).click();
}
const toast = () => page.getByTestId("palette-toast");

test("opens with Ctrl+K, filters, and goes to a page", async () => {
  await page.goto("/");
  await openPalette();
  await palette().getByRole("combobox").fill("audit log");
  await expect(palette().getByTestId("palette-go:audit")).toBeVisible();
  await expect(palette().getByTestId("palette-go:tickets")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/admin\/audit/);
  await page.keyboard.press("Control+k");
  await page.keyboard.press("Escape");
  await expect(palette()).toHaveCount(0);
});

test("switching the theme from the palette", async () => {
  await page.goto("/");
  const before = await page.evaluate(() => document.documentElement.classList.contains("dark"));
  await run("mode", "palette-act:theme");
  await expect(toast()).toContainText(/Switched to (dark|light) mode/);
  const after = await page.evaluate(() => document.documentElement.classList.contains("dark"));
  expect(after).toBe(!before);
  await run("mode", "palette-act:theme");
  expect(await page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(before);
});

test("copying the link and marking notifications read", async () => {
  await page.goto("/wiki");
  await run("copy link", "palette-act:copy-link");
  await expect(toast()).toHaveText("Link copied.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/\/wiki$/);
  await run("mark all", "palette-act:read-all");
  await expect(toast()).toHaveText("All notifications marked as read.");
  const unread = await page.evaluate(async () => ((await (await fetch("/api/v1/notifications/unread-count", { credentials: "same-origin" })).json()) as { count: number }).count);
  expect(unread).toBe(0);
});

test("pausing alerts asks first, can be cancelled, then pauses and resumes", async () => {
  await page.goto("/");
  const state = () => page.evaluate(async () => ((await (await fetch("/api/v1/monitors/maintenance", { credentials: "same-origin" })).json()) as { enabled: boolean }).enabled);
  expect(await state()).toBe(false);

  await openPalette();
  await palette().getByRole("combobox").fill("pause alerts");
  await expect(palette().getByTestId("palette-act:alerts-resume")).toHaveCount(0);
  await palette().getByTestId("palette-act:alerts-pause-60").click();
  await expect(page.getByTestId("palette-confirm")).toContainText("will not be sent");
  // Escape backs out of the question, not the palette.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("palette-confirm")).toHaveCount(0);
  await expect(palette().getByRole("combobox")).toBeVisible();
  expect(await state()).toBe(false);

  await palette().getByRole("combobox").fill("pause alerts");
  await palette().getByTestId("palette-act:alerts-pause-60").click();
  await page.getByTestId("palette-confirm-go").click();
  await expect(toast()).toContainText("Alerts paused until");
  expect(await state()).toBe(true);

  await openPalette();
  await palette().getByRole("combobox").fill("alerts");
  await expect(palette().getByTestId("palette-act:alerts-pause-60")).toHaveCount(0);
  await palette().getByTestId("palette-act:alerts-resume").click();
  await expect(toast()).toHaveText("Alerts are back on.");
  expect(await state()).toBe(false);
});

test("on a ticket: take it, then resolve it", async () => {
  const ticket = await page.evaluate(async (title) => {
    const r = await fetch("/api/v1/tickets", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, description: "palette test", priority: "low" }) });
    return (await r.json()) as { id: string };
  }, `${PREFIX} ticket`);
  const read = () => page.evaluate(async (id) => (await (await fetch(`/api/v1/tickets/${id}`, { credentials: "same-origin" })).json()) as { status: string; assignedUserId: string | null }, ticket.id);
  await page.goto(`/tickets/${ticket.id}`);
  await openPalette();
  await expect(palette().getByTestId("palette-page:ticket-take")).toBeVisible();
  await palette().getByRole("combobox").fill("take this");
  await palette().getByTestId("palette-page:ticket-take").click();
  await expect(toast()).toHaveText("The ticket is yours.");
  const me = await page.evaluate(async () => ((await (await fetch("/api/v1/me", { credentials: "same-origin" })).json()) as { id: string }).id);
  expect((await read()).assignedUserId).toBe(me);

  await run("resolved", "palette-page:ticket-resolve");
  await expect(toast()).toHaveText("Ticket marked resolved.");
  expect((await read()).status).toBe("resolved");
});

test("on a wiki page: history, and confirming it is still correct", async () => {
  const wiki = await page.evaluate(async (title) => {
    const r = await fetch("/api/v1/wiki", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, body: "text", visibility: "public" }) });
    return (await r.json()) as { id: string };
  }, `${PREFIX} page`);
  await page.goto(`/wiki/${wiki.id}`);
  await run("still correct", "palette-page:wiki-confirm");
  await expect(toast()).toHaveText("Marked as still correct.");
  const reviewed = await page.evaluate(async (id) => ((await (await fetch(`/api/v1/wiki/${id}`, { credentials: "same-origin" })).json()) as { lastReviewedAt: string | null }).lastReviewedAt, wiki.id);
  expect(reviewed).not.toBeNull();

  await run("history", "palette-page:wiki-history");
  await page.waitForURL(new RegExp(`/wiki/${wiki.id}/revisions`));
  // On the history screen it does not offer to open itself again.
  await openPalette();
  await expect(palette().getByTestId("palette-page:wiki-history")).toHaveCount(0);
  await expect(palette().getByTestId("palette-page:wiki-edit")).toBeVisible();
});
