import { test, expect, type Page } from "@playwright/test";

// The UniFi devices table's "Picture" column, driven by fake API answers (page.route) and with the realtime socket closed,
// so nothing reaches the controller, the database or the store.
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

const PROFILE_ID = "6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const MAC = "02:5e:00:00:00:02";

async function fakeUnifi(page: Page) {
  const now = new Date().toISOString();
  const device = { name: "Hall switch", model: "E2EUSW24", ip: "10.0.0.2", mac: MAC, state: 1, type: "usw", num_sta: 3, uptime: 3600, port_table: [{}], acked: false, switchModelId: null as string | null, switchViewOff: false };
  const profile = {
    id: PROFILE_ID, name: "E2E USW 24", kind: "switch", match: ["E2EUSW24"], portSide: "front",
    frontImageId: null, backImageId: null, frontWidth: null, frontHeight: null, backWidth: null, backHeight: null,
    ports: [], modules: [], createdAt: now, updatedAt: now,
  };
  const puts: unknown[] = [];
  await page.routeWebSocket(/\/socket\.io\//, (ws) => ws.close());
  await page.route("**/api/me", async (route) => {
    const res = await route.fetch();
    const me = (await res.json()) as { permissions?: string[] };
    await route.fulfill({ response: res, json: { ...me, permissions: [...(me.permissions ?? []), "monitors:write:any", "unifi:read:any"] } });
  });
  await page.route("**/api/switch-models", (route) => route.fulfill({ json: [profile] }));
  await page.route("**/api/unifi/health", (route) => route.fulfill({ json: { configured: true, reachable: true, error: null } }));
  await page.route("**/api/unifi/devices", (route) => route.fulfill({ json: [device] }));
  await page.route("**/api/unifi/clients", (route) => route.fulfill({ json: [] }));
  await page.route(`**/api/unifi/devices/${encodeURIComponent(MAC)}/switch-view`, async (route) => {
    const body = route.request().postDataJSON() as { mode: string; modelId?: string };
    puts.push(body);
    device.switchViewOff = body.mode === "off";
    device.switchModelId = body.mode === "model" ? (body.modelId ?? null) : null;
    await route.fulfill({ json: { mac: MAC, switchModelId: device.switchModelId, switchViewOff: device.switchViewOff } });
  });
  return { puts };
}

test.describe("UniFi device pictures", () => {
  test("a device shows the profile it matches, and the picture can be turned off", async ({ page }) => {
    await signInAsTestUser(page);
    const { puts } = await fakeUnifi(page);
    await page.goto("/monitoring/network");
    const button = page.getByRole("button", { name: "Choose the picture of Hall switch" });
    await expect(button).toHaveText(/E2E USW 24/);
    await button.click();
    const dialog = page.getByRole("dialog", { name: "Picture of Hall switch" });
    await expect(dialog.getByLabel("Device profile")).toHaveValue("auto");
    await expect(dialog.getByRole("option", { name: /Automatic \(E2E USW 24, matched on "E2EUSW24"\)/ })).toBeAttached();
    await dialog.getByLabel("Device profile").selectOption("off");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();
    expect(puts).toEqual([{ mode: "off" }]);
    await expect(button).toHaveText(/No picture/);
  });
});
