import { test, expect, type Page } from "@playwright/test";

// Equipment and rooms in the browser (docs/assets.md). Makes one room and one item through the API, walks the pages (list,
// item, check out and back in, label, room page, its sign, a ticket prefilled from the room) and removes both. Nothing here
// touches a device.
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

const stamp = Date.now();
const ROOM = `[e2e] Booth ${stamp}`;
const ITEM = `[e2e] Wireless pack ${stamp}`;

test("equipment and rooms: find an item, check it out and back, print its label, report a problem from its room", async ({ page }) => {
  await signInAsTestUser(page);
  const api = page.request;
  const room = await (await api.post("/api/locations", { data: { name: ROOM, building: "[e2e] Main" } })).json();
  const item = await (await api.post("/api/assets", { data: { name: ITEM, category: "audio", make: "Sennheiser", locationId: room.id } })).json();
  try {
    expect(item.tag).toMatch(/^A-\d{4,}$/);

    await page.goto(`/assets?q=${encodeURIComponent(ITEM)}`);
    const row = page.getByRole("row", { name: new RegExp(item.tag) });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Available");
    await row.getByRole("link", { name: ITEM }).click();
    await page.waitForURL(`**/assets/${item.id}`);

    await page.getByRole("button", { name: "Check out to me" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Check out" }).click();
    await expect(page.getByRole("region", { name: "Where it is" })).toContainText("With");
    await expect(page.getByRole("region", { name: "Check-out history" })).toContainText("Still out");
    await page.getByRole("button", { name: "I have returned it" }).click();
    await expect(page.getByRole("region", { name: "Where it is" })).toContainText("Available");

    await page.goto(`/print/assets?ids=${item.id}`);
    const label = page.getByTestId("asset-label");
    await expect(label).toHaveCount(1);
    await expect(label).toContainText(item.tag);
    await expect(label.locator("svg")).toHaveCount(1);

    await page.goto(`/rooms/${room.id}`);
    await expect(page.getByRole("heading", { name: ROOM })).toBeVisible();
    await expect(page.getByRole("region", { name: "Equipment kept here" })).toContainText(ITEM);
    await page.getByRole("link", { name: "Print sign" }).click();
    await expect(page.getByTestId("room-qr").locator("svg")).toHaveCount(1);
    await expect(page.getByText(`/tickets/new?room=${room.id}`)).toBeVisible();

    await page.goto(`/tickets/new?room=${room.id}&asset=${item.id}`);
    await expect(page.getByLabel("Where (optional)")).toHaveValue(room.id);
    await expect(page.getByText(item.tag)).toBeVisible();

    await page.goto("/rooms");
    await expect(page.getByRole("link", { name: ROOM })).toBeVisible();
  } finally {
    await api.delete(`/api/assets/${item.id}`);
    await api.delete(`/api/locations/${room.id}`);
  }
});
