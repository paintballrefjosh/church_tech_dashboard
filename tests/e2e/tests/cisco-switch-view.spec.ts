import { test, expect, type Page } from "@playwright/test";

// The switch page is driven by fake API answers (page.route), so nothing here can reach a real switch.
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
}

const SW_ID = "44444444-4444-4444-8444-444444444444";
const NOW = new Date().toISOString();

const fakeSwitch = (model: string | null) => ({
  id: SW_ID,
  hostname: "Fake-SW01",
  ipAddress: "192.0.2.10",
  username: "x",
  model,
  location: null,
  reachable: true,
  uptime: null,
  lastPolledAt: NOW,
  lastError: null,
  configDrift: false,
  checkPortState: false,
  alertPrefs: {},
  hasPassword: true,
  createdAt: NOW,
  updatedAt: NOW,
});

const port = (n: number, over: Record<string, unknown> = {}) => ({
  id: `55555555-5555-4555-8555-0000000000${String(n).padStart(2, "0")}`,
  portId: `Gi1/0/${n}`,
  description: `desk ${n}`,
  adminEnabled: true,
  speed: "auto",
  duplex: "auto",
  mode: "access",
  hasSwitchport: true,
  accessVlan: 10,
  trunkNativeVlan: 1,
  trunkAllowedVlans: "1-4094",
  operStatus: "up",
  neighborHostname: null,
  neighborPort: null,
  ...over,
});

async function fakeApi(page: Page, model: string | null) {
  const ports = [
    port(1, { description: "Front desk phone" }),
    port(2, { operStatus: "down" }),
    port(3, { adminEnabled: false, operStatus: "down" }),
    // A cage that is in the desired config under both of its names: only the one the switch reported on is drawn.
    { ...port(1), id: "55555555-5555-4555-8555-000000000101", portId: "Gi1/1/1", operStatus: null },
    { ...port(1), id: "55555555-5555-4555-8555-000000000102", portId: "Te1/1/1", operStatus: "up" },
    { ...port(1), id: "55555555-5555-4555-8555-000000000103", portId: "Po10", operStatus: "up" },
  ];
  // No admin switch models: the page falls back to the built-in layouts, so what is drawn does not depend on the pictures and
  // add-on modules that happen to be in the real database (a module on the real WS-C3850-48 model once broke the cage check below).
  await page.route("**/api/switch-models", (route) => route.fulfill({ json: [] }));
  await page.route(`**/api/cisco/switches/${SW_ID}`, (route) => route.fulfill({ json: fakeSwitch(model) }));
  await page.route(`**/api/cisco/switches/${SW_ID}/ports`, (route) => route.fulfill({ json: ports }));
  await page.route(`**/api/cisco/switches/${SW_ID}/vlans`, (route) => route.fulfill({ json: [{ vlanId: 10, name: "staff" }] }));
  // Show the write buttons whatever the test user's tier is: the page only reads this to decide what to offer.
  await page.route("**/api/me", async (route) => {
    const res = await route.fetch();
    const me = (await res.json()) as { permissions?: string[] };
    await route.fulfill({ response: res, json: { ...me, permissions: [...(me.permissions ?? []), "monitors:write:any"] } });
  });
}

test.describe("Cisco switch page: switch view", () => {
  test("opens on the picture of the switch, with a popover per port", async ({ page }) => {
    await signInAsTestUser(page);
    await fakeApi(page, "WS-C3850-48F-E");
    await page.goto(`/monitoring/network-cisco/switches/${SW_ID}`);

    await expect(page.getByRole("region", { name: /, ports$/ })).toBeVisible();
    await expect(page.getByRole("group", { name: "Show ports as" }).getByRole("button", { name: "Switch view" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("table")).toHaveCount(0);

    // The uplink cage is drawn once, as the name the switch reported on; the other name and the port channel are listed below.
    await expect(page.locator('[data-port="Te1/1/1"]')).toHaveCount(1);
    await expect(page.getByRole("region", { name: /, ports$/ }).locator('[data-port="Gi1/1/1"]')).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Other interfaces" })).toContainText("Po10");

    await page.locator('[data-port="Gi1/0/1"]').hover();
    const pop = page.getByRole("dialog", { name: "Gi1/0/1 details" });
    await expect(pop).toContainText("Front desk phone");
    await expect(pop).toContainText("access");
    await expect(pop.getByRole("button", { name: "Edit" })).toBeVisible();
    await expect(pop.getByRole("button", { name: "Delete" })).toBeVisible();

    // The popover can be reached with the pointer, and Edit opens the same form as the list's.
    await pop.getByRole("button", { name: "Edit" }).click();
    await expect(page.getByRole("dialog", { name: /Edit Gi1\/0\/1/ })).toBeVisible();
  });

  test("a port can be reached and pinned from the keyboard", async ({ page }) => {
    await signInAsTestUser(page);
    await fakeApi(page, "WS-C3850-48F-E");
    await page.goto(`/monitoring/network-cisco/switches/${SW_ID}`);
    const p = page.locator('[data-port="Gi1/0/3"]');
    await p.focus();
    await page.keyboard.press("Enter");
    const pop = page.getByRole("dialog", { name: "Gi1/0/3 details" });
    await expect(pop).toContainText("shut");
    await expect(pop.getByRole("button", { name: "Enable" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(pop).toHaveCount(0);
    await expect(p).toBeFocused();
  });

  test("the list view is one click away, and the choice is remembered", async ({ page }) => {
    await signInAsTestUser(page);
    await fakeApi(page, "WS-C3850-48F-E");
    await page.goto(`/monitoring/network-cisco/switches/${SW_ID}`);
    await page.getByRole("button", { name: "List view" }).click();
    await expect(page.getByRole("table")).toBeVisible();
    await expect(page.getByLabel("Rows")).toBeVisible();
    await page.reload();
    await expect(page.getByRole("table")).toBeVisible();
    await page.getByRole("button", { name: "Switch view" }).click();
    await expect(page.getByRole("region", { name: /, ports$/ })).toBeVisible();
  });

  test("a model with no faceplate gets the list and no toggle", async ({ page }) => {
    await signInAsTestUser(page);
    await fakeApi(page, "WS-C2960-24TT-L");
    await page.goto(`/monitoring/network-cisco/switches/${SW_ID}`);
    await expect(page.getByRole("table")).toBeVisible();
    await expect(page.getByRole("group", { name: "Show ports as" })).toHaveCount(0);
  });

  test("says why a switch has no picture, and the Edit switch form can turn the view off for that switch", async ({ page }) => {
    await signInAsTestUser(page);
    await fakeApi(page, "WS-C2960-24TT-L");
    let saved: unknown = null;
    let off = false;
    // Registered after fakeApi, so these answer first: the switch remembers what was saved.
    // The form saves the switch itself (PATCH) before the view; both answer with the switch as it is now.
    await page.route(`**/api/cisco/switches/${SW_ID}`, (route) => route.fulfill({ json: { ...fakeSwitch("WS-C2960-24TT-L"), switchViewOff: off } }));
    await page.route(`**/api/cisco/switches/${SW_ID}/switch-view`, async (route) => {
      saved = route.request().postDataJSON();
      off = (saved as { mode: string }).mode === "off";
      await route.fulfill({ json: { ...fakeSwitch("WS-C2960-24TT-L"), switchViewOff: off } });
    });
    await page.goto(`/monitoring/network-cisco/switches/${SW_ID}`);
    const line = page.getByTestId("switch-view-line");
    await expect(line).toContainText('No device profile matches "WS-C2960-24TT-L"');
    // the match is not chosen on the page itself, only in the form
    await expect(page.getByRole("combobox", { name: /Switch view/ })).toHaveCount(0);

    await page.getByRole("button", { name: "Edit switch" }).click();
    const picker = page.getByRole("combobox", { name: /Switch view/ });
    await expect(picker).toHaveValue("auto");
    await picker.selectOption("off");
    await expect(page.getByText(/turned off for this switch/).first()).toBeVisible(); // the form's own preview
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(line).toContainText("turned off for this switch");
    expect(saved).toEqual({ mode: "off" });
  });

  test("the switch list shows a switch's ports in a card that follows the mouse over its row", async ({ page }) => {
    await signInAsTestUser(page);
    await fakeApi(page, "WS-C3850-48F-E");
    // Two switches: one the built-in layouts draw, one with no picture (which gets no card).
    const other = { ...fakeSwitch("NO-SUCH-MODEL"), id: "66666666-6666-4666-8666-666666666666", hostname: "Fake-SW02" };
    await page.route("**/api/cisco/switches", (route) => route.fulfill({ json: [fakeSwitch("WS-C3850-48F-E"), other] }));
    await page.goto("/monitoring/network-cisco");
    const row = page.getByRole("row").filter({ hasText: "Fake-SW01" });
    const card = page.getByTestId("switch-hover-preview");
    await expect(card).toHaveCount(0);

    const box = (await row.boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + box.height / 2);
    await expect(card).toBeVisible();
    await expect(card).toContainText("Fake-SW01");
    // Three ports on the picture: up, no link, shut down (the cage drawn once, the port channel not drawn).
    await expect(card).toContainText("2 up, 1 enabled, no link, 1 shut down");
    await expect(card.locator('[data-state="shut"]')).toHaveCount(1);

    // It follows the pointer.
    const before = (await card.boundingBox())!;
    await page.mouse.move(box.x + 240, box.y + box.height / 2);
    await expect.poll(async () => (await card.boundingBox())!.x).toBeGreaterThan(before.x + 150);

    // A switch with no picture gets no card, and leaving the rows hides it.
    const plain = (await page.getByRole("row").filter({ hasText: "Fake-SW02" }).boundingBox())!;
    await page.mouse.move(plain.x + 40, plain.y + plain.height / 2);
    await expect(card).toHaveCount(0);
    await page.mouse.move(box.x + 40, box.y + box.height / 2);
    await expect(card).toBeVisible();
    await page.mouse.move(5, 5);
    await expect(card).toHaveCount(0);
  });
});
