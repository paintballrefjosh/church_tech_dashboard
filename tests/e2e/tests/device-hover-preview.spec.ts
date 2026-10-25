import { test, expect, type Page } from "@playwright/test";

// The hover cards on the UniFi devices list and the infrastructure overview: a device profile's picture follows the mouse,
// and a device with no profile gets none. Driven by fake API answers (page.route), so nothing reaches the controller, the
// hosts, the database or the store.
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

const SWITCH_PROFILE = "9d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f60";
const AP_PROFILE = "ae5f6a7b-8c9d-4e0f-9a1b-2c3d4e5f6071";
const HOST_A = "bf6a7b8c-9d0e-4f1a-8b2c-3d4e5f607182";
const HOST_B = "c07b8c9d-0e1f-4a2b-9c3d-4e5f60718293";

function profiles() {
  const now = new Date().toISOString();
  const base = { kind: "switch", portSide: "front", backImageId: null, backWidth: null, backHeight: null, modules: [], createdAt: now, updatedAt: now };
  return [
    {
      ...base, id: SWITCH_PROFILE, name: "E2E USW 8", match: ["E2EUSW8"], frontImageId: "d18c9d0e-1f2a-4b3c-8d4e-5f60718293a4", frontWidth: 1000, frontHeight: 100,
      ports: [
        { name: "1", aliases: [], kind: "rj45", x: 0.1, y: 0.2, w: 0.05, h: 0.5 },
        { name: "2", aliases: [], kind: "rj45", x: 0.2, y: 0.2, w: 0.05, h: 0.5 },
      ],
    },
    // A profile with a picture and no ports: an access point, or a host.
    { ...base, id: AP_PROFILE, name: "E2E AP", match: ["E2EAP"], frontImageId: "e29d0e1f-2a3b-4c4d-9e5f-60718293a4b5", frontWidth: 400, frontHeight: 400, ports: [] },
  ];
}

async function hover(page: Page, text: string) {
  const box = (await page.getByRole(text.startsWith("E2E host") ? "listitem" : "row").filter({ hasText: text }).boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + box.height / 2);
  return box;
}

test.describe("Device hover cards", () => {
  test("UniFi devices: a profile's picture follows the mouse; a device with no profile gets no card", async ({ page }) => {
    await signInAsTestUser(page);
    const dev = { ip: "10.0.0.3", state: 1, num_sta: 0, uptime: 60, acked: false, switchModelId: null, switchViewOff: false };
    const devices = [
      {
        ...dev, name: "Hall switch", model: "E2EUSW8", mac: "02:5e:00:00:00:21", type: "usw",
        port_table: [
          { port_idx: 1, up: true, enable: true, speed: 1000 },
          { port_idx: 2, up: false, enable: true },
        ],
      },
      { ...dev, name: "Office AP", model: "E2EAP", mac: "02:5e:00:00:00:22", type: "uap" },
      { ...dev, name: "Mystery box", model: "NO-SUCH-MODEL", mac: "02:5e:00:00:00:23", type: "usw", port_table: [{ port_idx: 1, up: true, enable: true }] },
    ];
    await page.routeWebSocket(/\/socket\.io\//, (ws) => ws.close());
    await page.route("**/api/switch-models", (route) => route.fulfill({ json: profiles() }));
    await page.route("**/api/unifi/health", (route) => route.fulfill({ json: { configured: true, reachable: true, error: null } }));
    await page.route("**/api/unifi/devices", (route) => route.fulfill({ json: devices }));
    await page.route("**/api/unifi/clients", (route) => route.fulfill({ json: [] }));
    await page.route("**/api/switch-models/**/images/**", (route) => route.fulfill({ status: 404, body: "" }));
    await page.goto("/monitoring/network");
    await expect(page.getByRole("link", { name: "Hall switch", exact: true })).toBeVisible();
    const card = page.getByTestId("device-hover-preview");

    const box = await hover(page, "Hall switch");
    await expect(card).toBeVisible();
    await expect(card).toContainText("E2E USW 8");
    await expect(card).toContainText("1 up, 1 enabled, no link");
    await expect(card.locator('[data-state="up"]')).toHaveCount(1);
    const before = (await card.boundingBox())!;
    await page.mouse.move(box.x + 240, box.y + box.height / 2);
    await expect.poll(async () => (await card.boundingBox())!.x).toBeGreaterThan(before.x + 150);

    // A profile with no ports shows its picture.
    await hover(page, "Office AP");
    await expect(card).toContainText("E2E AP");
    await expect(card.locator("img")).toHaveCount(1);

    // No profile matches: no card, even though a built-in drawing might exist for the model.
    await hover(page, "Mystery box");
    await expect(card).toHaveCount(0);
    await page.mouse.move(5, 5);
    await expect(card).toHaveCount(0);
  });

  test("infrastructure: the host's chosen profile picture follows the mouse; a host with none gets no card", async ({ page }) => {
    await signInAsTestUser(page);
    const now = new Date().toISOString();
    const host = {
      os: "linux", capabilities: [], enabled: true, intervalSec: 30, options: {}, thresholds: [], status: "up", lastPolledAt: now, lastError: null,
      lastSample: null, hasCredential: false, authType: null, runbookPageId: null, createdAt: now, updatedAt: now,
    };
    const targets = [
      { ...host, id: HOST_A, name: "E2E host A", host: "10.0.0.41", switchModelId: AP_PROFILE },
      { ...host, id: HOST_B, name: "E2E host B", host: "10.0.0.42", switchModelId: null },
    ];
    await page.route("**/api/switch-models", (route) => route.fulfill({ json: profiles() }));
    await page.route("**/api/infra/targets", (route) => route.fulfill({ json: targets }));
    await page.route("**/api/switch-models/**/images/**", (route) => route.fulfill({ status: 404, body: "" }));
    await page.goto("/monitoring/infra");
    // The page renders the real hosts first; the faked list arrives with the client's first refetch (on socket connect).
    await expect(page.getByText("E2E host A")).toBeVisible({ timeout: 15_000 });
    const card = page.getByTestId("host-hover-preview");

    await hover(page, "E2E host A");
    await expect(card).toBeVisible();
    await expect(card).toContainText("E2E AP");
    await expect(card.locator("img")).toHaveCount(1);
    await hover(page, "E2E host B");
    await expect(card).toHaveCount(0);
  });
});
