import { test, expect, type Page } from "@playwright/test";

// Add-on modules (a C3KX-NM-10G on a Catalyst 3750-X). Driven by fake API answers (page.route), so nothing here writes to
// the real database or store, and no real switch is needed.
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

const SW_ID = "44444444-4444-4444-8444-444444444445";
const MODEL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab";
const IMG_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccd";
const NOW = new Date().toISOString();

/** A flat grey picture drawn in the page, so the test needs no image files. */
async function makePng(page: Page, w: number, h: number): Promise<Buffer> {
  const b64 = await page.evaluate(
    ([width, height]) => {
      const c = document.createElement("canvas");
      c.width = width!;
      c.height = height!;
      const g = c.getContext("2d")!;
      g.fillStyle = "#c8ccd2";
      g.fillRect(0, 0, width!, height!);
      return c.toDataURL("image/png").split(",")[1]!;
    },
    [w, h],
  );
  return Buffer.from(b64, "base64");
}

const model = {
  id: MODEL_ID,
  name: "Catalyst 3850-48F",
  kind: "switch",
  match: ["WS-C3850-48F"],
  portSide: "front",
  frontImageId: IMG_ID,
  backImageId: null,
  frontWidth: 2000,
  frontHeight: 200,
  backWidth: null,
  backHeight: null,
  ports: [1, 2, 3, 4].map((n) => ({ name: `Gi1/0/${n}`, aliases: [], kind: "rj45", x: 0.05 + n * 0.05, y: 0.2, w: 0.04, h: 0.4 })),
  modules: [],
  createdAt: NOW,
  updatedAt: NOW,
};

const fakeSwitch = {
  id: SW_ID,
  hostname: "Fake-3850",
  ipAddress: "192.0.2.11",
  username: "x",
  model: "WS-C3850-48F-E",
  location: null,
  reachable: true,
  uptime: null,
  lastPolledAt: NOW,
  lastError: null,
  configDrift: false,
  checkPortState: false,
  checkPortChannels: false,
  alertPrefs: {},
  hasPassword: true,
  switchModelId: null,
  switchViewOff: false,
  createdAt: NOW,
  updatedAt: NOW,
};

const poe = (over: Record<string, unknown>) => ({ status: "on", device: "Ieee PD", ieeeClass: 4, allocatedMw: 25500, measuredMw: 8100, ...over });

const port = (n: number, extra: Record<string, unknown>) => ({
  id: `55555555-5555-4555-8555-0000000000${String(n).padStart(2, "0")}`,
  portId: `Gi1/0/${n}`,
  description: `port ${n}`,
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
  poe: null,
  ...extra,
});

async function fakeApi(page: Page, ports: unknown[]) {
  const png = await makePng(page, 2000, 200);
  await page.route("**/api/me", async (route) => {
    const res = await route.fetch();
    const me = (await res.json()) as { permissions?: string[] };
    await route.fulfill({ response: res, json: { ...me, permissions: [...(me.permissions ?? []), "monitors:write:any"] } });
  });
  await page.route("**/api/switch-models", (route) => route.fulfill({ json: [model] }));
  await page.route("**/api/switch-models/*/images/*", (route) => route.fulfill({ body: png, contentType: "image/png" }));
  await page.route(`**/api/cisco/switches/${SW_ID}`, (route) => route.fulfill({ json: fakeSwitch }));
  await page.route(`**/api/cisco/switches/${SW_ID}/ports`, (route) => route.fulfill({ json: ports }));
  await page.route(`**/api/cisco/switches/${SW_ID}/vlans`, (route) => route.fulfill({ json: [{ vlanId: 10, name: "staff" }] }));
}

const PORTS = [
  port(1, { poe: poe({}) }), // PoE+ phone-class device, 8.1 W measured of 25.5 W set aside
  port(2, { poe: poe({ ieeeClass: 0, allocatedMw: 15400, measuredMw: 2400 }) }), // plain PoE
  port(3, { poe: poe({ status: "off", device: null, ieeeClass: null, allocatedMw: 0, measuredMw: 0 }) }), // PoE port, nothing plugged in
  port(4, { poe: null }), // no PoE reading (an uplink)
];

test.describe("Cisco switch page: Power over Ethernet", () => {
  test("a port that is powering a device has a lightning bolt and says so in its name", async ({ page }) => {
    await signInAsTestUser(page);
    await fakeApi(page, PORTS);
    await page.goto(`/monitoring/network-cisco/switches/${SW_ID}`);
    const plate = page.getByRole("region", { name: /, ports$/ });
    await expect(plate).toBeVisible();
    await expect(plate.locator('[data-port="Gi1/0/1"] svg')).toHaveCount(1);
    await expect(plate.locator('[data-port="Gi1/0/2"] svg')).toHaveCount(1);
    await expect(plate.locator('[data-port="Gi1/0/3"] svg')).toHaveCount(0);
    await expect(plate.locator('[data-port="Gi1/0/4"] svg')).toHaveCount(0);
    await expect(plate.locator('[data-port="Gi1/0/1"]')).toHaveAttribute("aria-label", /PoE\+, 8\.1 W/);
    await expect(page.getByRole("list", { name: "Port colours" })).toContainText("Powering a device (PoE)");
    await expect(page.getByText("10.5 W of PoE in use.")).toBeVisible();
  });

  test("the hover window gives the PoE kind and the power in use", async ({ page }) => {
    await signInAsTestUser(page);
    await fakeApi(page, PORTS);
    await page.goto(`/monitoring/network-cisco/switches/${SW_ID}`);
    const plate = page.getByRole("region", { name: /, ports$/ });

    await plate.locator('[data-port="Gi1/0/1"]').hover();
    const pop = page.getByRole("dialog", { name: "Gi1/0/1 details" });
    await expect(pop).toContainText("PoE+ (802.3at) · class 4");
    await expect(pop).toContainText("8.1 W in use · 25.5 W set aside");
    await expect(pop).toContainText("Ieee PD");

    await plate.locator('[data-port="Gi1/0/2"]').hover();
    await expect(page.getByRole("dialog", { name: "Gi1/0/2 details" })).toContainText("PoE (802.3af) · class 0");

    await plate.locator('[data-port="Gi1/0/3"]').hover();
    await expect(page.getByRole("dialog", { name: "Gi1/0/3 details" })).toContainText("no device powered");

    // a port with no PoE reading has no PoE row at all
    await plate.locator('[data-port="Gi1/0/4"]').hover();
    await expect(page.getByRole("dialog", { name: "Gi1/0/4 details" })).not.toContainText("PoE");
  });

  test("a switch with no PoE has no bolt, no legend entry and no PoE column", async ({ page }) => {
    await signInAsTestUser(page);
    await fakeApi(page, PORTS.map((p) => ({ ...p, poe: null })));
    await page.goto(`/monitoring/network-cisco/switches/${SW_ID}`);
    const plate = page.getByRole("region", { name: /, ports$/ });
    await expect(plate).toBeVisible();
    await expect(plate.locator("[data-port] svg")).toHaveCount(0);
    await expect(page.getByRole("list", { name: "Port colours" })).not.toContainText("PoE");
    await expect(page.getByText(/of PoE in use/)).toHaveCount(0);
  });

  test("the list view has a PoE column", async ({ page }) => {
    await signInAsTestUser(page);
    await fakeApi(page, PORTS);
    await page.goto(`/monitoring/network-cisco/switches/${SW_ID}`);
    await page.getByRole("button", { name: "List view" }).click();
    await expect(page.getByRole("row", { name: /Gi1\/0\/1 / })).toContainText("PoE+, 8.1 W");
    await expect(page.getByRole("row", { name: /Gi1\/0\/3 / })).toContainText("off");
  });
});
