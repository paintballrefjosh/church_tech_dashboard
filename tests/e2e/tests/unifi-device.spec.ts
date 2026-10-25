import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// The UniFi device page and its switch view, driven by fake API answers (page.route) with the realtime socket closed,
// so nothing reaches the controller, the database or the store. Nothing here changes a port.
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

const PROFILE_ID = "7b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";
const IMG_ID = "8c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f";
const MAC = "02:5e:00:00:00:03";

async function fakeUnifi(page: Page) {
  const now = new Date().toISOString();
  const device = {
    name: "Hall switch", model: "E2EUSW8", ip: "10.0.0.3", mac: MAC, state: 1, type: "usw", num_sta: 1, uptime: 7200,
    acked: false, switchModelId: null, switchViewOff: false,
    port_table: [
      { port_idx: 1, name: "Projector", up: true, enable: true, speed: 1000, full_duplex: true, poe_enable: true, poe_power: "4.20", poe_class: "Class 2" },
      { port_idx: 2, name: "Port 2", up: false, enable: true },
    ],
  };
  const profile = {
    id: PROFILE_ID, name: "E2E USW 8", kind: "switch", match: ["E2EUSW8"], portSide: "front",
    frontImageId: IMG_ID, backImageId: null, frontWidth: 1000, frontHeight: 100, backWidth: null, backHeight: null,
    ports: [
      { name: "1", aliases: [], kind: "rj45", x: 0.1, y: 0.2, w: 0.05, h: 0.5 },
      { name: "2", aliases: [], kind: "rj45", x: 0.2, y: 0.2, w: 0.05, h: 0.5 },
    ],
    modules: [], createdAt: now, updatedAt: now,
  };
  const client = { name: "Booth projector", hostname: "proj", ip: "10.0.10.50", mac: "02:5e:00:00:01:01", is_wired: true, sw_mac: MAC, sw_port: 1 };
  const sheet = {
    kind: "unifi", device: { id: MAC, name: "Hall switch", ip: "10.0.0.3", model: "E2EUSW8", location: null }, generatedAt: now, notes: [],
    ports: [
      { port: "1", description: "Projector", mode: "access", vlan: "10 AV", subnet: "10.0.10.0/24", link: "up" },
      { port: "2", description: "", mode: "access", vlan: "1 Default", subnet: "-", link: "down" },
    ],
  };
  await page.routeWebSocket(/\/socket\.io\//, (ws) => ws.close());
  await page.route("**/api/switch-models", (route) => route.fulfill({ json: [profile] }));
  await page.route("**/api/unifi/health", (route) => route.fulfill({ json: { configured: true, reachable: true, error: null } }));
  await page.route("**/api/unifi/devices", (route) => route.fulfill({ json: [device] }));
  await page.route("**/api/unifi/clients", (route) => route.fulfill({ json: [client] }));
  await page.route(`**/api/port-sheets/unifi/${encodeURIComponent(MAC)}`, (route) => route.fulfill({ json: sheet }));
  // The picture itself: a missing image is drawn without it, so a 404 is fine and keeps the store out of it.
  await page.route(`**/${IMG_ID}**`, (route) => route.fulfill({ status: 404, body: "" }));
}

async function expectNoAxeViolations(page: Page) {
  await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important;animation:none!important}" });
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
  expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

test.describe("UniFi device page", () => {
  test("the devices table links to the page, which draws the switch with each port's details", async ({ page }) => {
    await signInAsTestUser(page);
    await fakeUnifi(page);
    await page.goto("/monitoring/network");
    await page.getByRole("link", { name: "Hall switch", exact: true }).click();
    await page.waitForURL(new RegExp(`/monitoring/network/devices/${encodeURIComponent(MAC)}$`));
    await expect(page.getByRole("heading", { name: "Hall switch", exact: true })).toBeVisible();
    await expect(page.getByText("1 of 2 ports up.")).toBeVisible();
    await expect(page.getByRole("list", { name: "Port colours" })).toHaveCount(1);

    const port1 = page.getByRole("button", { name: "1, up, 1 Gbps, PoE, 4.2 W" });
    await expect(port1).toBeVisible();
    await expect(page.getByRole("button", { name: "2, no link" })).toBeVisible();
    await port1.click();
    const pop = page.getByRole("dialog").filter({ hasText: "Port 1" });
    await expect(pop).toContainText("Projector");
    await expect(pop).toContainText("10 AV");
    await expect(pop).toContainText("10.0.10.0/24");
    await expect(pop).toContainText("Booth projector");
    await page.keyboard.press("Escape");
    await expectNoAxeViolations(page);

    await page.getByRole("button", { name: "List view" }).click();
    await expectNoAxeViolations(page);
    const row1 = page.getByRole("row").filter({ hasText: "Projector" });
    await expect(row1).toContainText("10 AV");
    await expect(row1).toContainText("Booth projector");
    await expect(page.getByRole("link", { name: /Printable page/ })).toHaveAttribute("href", `/print/unifi/${encodeURIComponent(MAC)}`);
    // Back to the switch view, so the next visit (remembered in this browser) starts as it would for anyone.
    await page.getByRole("button", { name: "Switch view" }).click();
  });

  test("the devices list: one toolbar row with the Devices/Clients switch, and Rows under the table", async ({ page }) => {
    await signInAsTestUser(page);
    await fakeUnifi(page);
    await page.goto("/monitoring/network");
    const show = page.getByRole("group", { name: "Show" });
    const devicesBtn = show.getByRole("button", { name: "Devices (1)" });
    const clientsBtn = show.getByRole("button", { name: "Clients (1)" });
    await expect(devicesBtn).toHaveAttribute("aria-pressed", "true");
    const search = page.getByPlaceholder("Search devices…");
    const vouchers = page.getByRole("link", { name: "Guest vouchers" });
    // The switch, the search and the page links share one row, above the table.
    const [a, b, c] = await Promise.all([show.boundingBox(), search.boundingBox(), vouchers.boundingBox()]);
    expect(Math.abs(a!.y + a!.height / 2 - (b!.y + b!.height / 2))).toBeLessThan(6);
    expect(Math.abs(b!.y + b!.height / 2 - (c!.y + c!.height / 2))).toBeLessThan(6);
    const table = await page.getByRole("table").boundingBox();
    const rows = await page.getByLabel("Rows").boundingBox();
    expect(rows!.y).toBeGreaterThan(table!.y + table!.height);
    expect(rows!.x + rows!.width).toBeGreaterThan(table!.x + table!.width - 120);
    await clientsBtn.click();
    await expect(clientsBtn).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByPlaceholder("Search clients…")).toBeVisible();
    await expect(page.getByRole("table").getByText("Booth projector")).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test("an address the controller does not list says so", async ({ page }) => {
    await signInAsTestUser(page);
    await fakeUnifi(page);
    await page.goto("/monitoring/network/devices/02%3A5e%3A00%3A00%3A00%3A99");
    await expect(page.getByText(/does not list this device/)).toBeVisible();
  });
});
