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

const SW_ID = "44444444-4444-4444-8444-444444444444";
const HOST_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MOD_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const IMG_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
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

const box = (name: string, x: number, aliases: string[] = []) => ({ name, aliases, kind: "sfp", x, y: 0.25, w: 0.2, h: 0.5 });

const host = (modules: unknown[]) => ({
  id: HOST_ID,
  name: "Catalyst 3750-X 24",
  kind: "switch",
  match: ["C3750X-24"],
  portSide: "front",
  frontImageId: IMG_ID,
  backImageId: null,
  frontWidth: 2000,
  frontHeight: 200,
  backWidth: null,
  backHeight: null,
  ports: [
    { name: "Gi1/0/1", aliases: [], kind: "rj45", x: 0.05, y: 0.2, w: 0.03, h: 0.3 },
    { name: "Gi1/0/2", aliases: [], kind: "rj45", x: 0.09, y: 0.2, w: 0.03, h: 0.3 },
  ],
  modules,
  createdAt: NOW,
  updatedAt: NOW,
});

const moduleModel = {
  id: MOD_ID,
  name: "C3KX-NM-10G",
  kind: "module",
  match: [],
  portSide: "front",
  frontImageId: IMG_ID,
  backImageId: null,
  frontWidth: 400,
  frontHeight: 200,
  backWidth: null,
  backHeight: null,
  ports: [box("Te1/1/1", 0.1, ["Gi1/1/1"]), box("Te1/1/2", 0.6)],
  modules: [],
  createdAt: NOW,
  updatedAt: NOW,
};

const placed = { id: "m1", moduleId: MOD_ID, x: 0.8, y: 0.25, w: 0.18, h: 0.45 };

const fakeSwitch = {
  id: SW_ID,
  hostname: "Fake-3750X",
  ipAddress: "192.0.2.10",
  username: "x",
  model: "WS-C3750X-24T-S",
  location: null,
  reachable: true,
  uptime: null,
  lastPolledAt: NOW,
  lastError: null,
  configDrift: false,
  checkPortState: false,
  alertPrefs: {},
  hasPassword: true,
  switchModelId: null,
  switchViewOff: false,
  createdAt: NOW,
  updatedAt: NOW,
};

const port = (portId: string, n: number) => ({
  id: `55555555-5555-4555-8555-0000000000${String(n).padStart(2, "0")}`,
  portId,
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
});

async function fakeApi(page: Page, ports: string[], models: unknown[]) {
  const png = await makePng(page, 400, 200);
  await page.route("**/api/me", async (route) => {
    const res = await route.fetch();
    const me = (await res.json()) as { permissions?: string[] };
    await route.fulfill({ response: res, json: { ...me, permissions: [...(me.permissions ?? []), "monitors:write:any"] } });
  });
  await page.route("**/api/switch-models", (route) => route.fulfill({ json: models }));
  await page.route("**/api/switch-models/*/images/*", (route) => route.fulfill({ body: png, contentType: "image/png" }));
  await page.route(`**/api/cisco/switches/${SW_ID}`, (route) => route.fulfill({ json: fakeSwitch }));
  await page.route(`**/api/cisco/switches/${SW_ID}/ports`, (route) => route.fulfill({ json: ports.map((p, i) => port(p, i + 1)) }));
  await page.route(`**/api/cisco/switches/${SW_ID}/vlans`, (route) => route.fulfill({ json: [{ vlanId: 10, name: "staff" }] }));
}

test.describe("Device profiles: add-on modules", () => {
  test("a switch that reports the module's ports shows the module and its ports", async ({ page }) => {
    await signInAsTestUser(page);
    await fakeApi(page, ["Gi1/0/1", "Gi1/0/2", "Te1/1/1", "Te1/1/2"], [host([placed]), moduleModel]);
    await page.goto(`/monitoring/network-cisco/switches/${SW_ID}`);
    const plate = page.getByRole("region", { name: /, ports$/ });
    await expect(plate).toBeVisible();
    await expect(plate.getByRole("img", { name: "C3KX-NM-10G" })).toBeVisible();
    await expect(plate.locator('[data-port="Te1/1/1"]')).toHaveCount(1);
    await expect(plate.locator('[data-port="Te1/1/2"]')).toHaveCount(1);
    // the popover works on a module's port like any other
    await plate.locator('[data-port="Te1/1/2"]').hover();
    await expect(page.getByRole("dialog", { name: "Te1/1/2 details" })).toContainText("port 4");
  });

  test("the module's other name for a cage lands on the same port", async ({ page }) => {
    await signInAsTestUser(page);
    await fakeApi(page, ["Gi1/0/1", "Gi1/1/1"], [host([placed]), moduleModel]);
    await page.goto(`/monitoring/network-cisco/switches/${SW_ID}`);
    const plate = page.getByRole("region", { name: /, ports$/ });
    await expect(plate.getByRole("img", { name: "C3KX-NM-10G" })).toBeVisible();
    await expect(plate.locator('[data-port="Gi1/1/1"]')).toHaveCount(1);
  });

  test("a switch without the module is drawn as it is, with no module and no empty cages", async ({ page }) => {
    await signInAsTestUser(page);
    await fakeApi(page, ["Gi1/0/1", "Gi1/0/2"], [host([placed]), moduleModel]);
    await page.goto(`/monitoring/network-cisco/switches/${SW_ID}`);
    const plate = page.getByRole("region", { name: /, ports$/ });
    await expect(plate).toBeVisible();
    await expect(plate.locator('[data-port="Gi1/0/1"]')).toHaveCount(1);
    await expect(plate.getByRole("img", { name: "C3KX-NM-10G" })).toHaveCount(0);
  });

  test("a module is added to a device profile from its page and saved", async ({ page }) => {
    await signInAsTestUser(page);
    await fakeApi(page, [], [host([]), moduleModel]);
    let body: { modules?: Array<{ moduleId: string; x: number; w: number; h: number }> } | null = null;
    await page.route(`**/api/switch-models/${HOST_ID}`, async (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      body = route.request().postDataJSON();
      return route.fulfill({ json: host(body?.modules ?? []) });
    });
    await page.goto(`/device-profiles/${HOST_ID}`);
    const section = page.getByRole("region", { name: "Add-on modules" });
    await expect(section.getByText("No modules on this device profile.")).toBeVisible();

    await section.getByRole("combobox", { name: "Add-on module" }).selectOption({ label: "C3KX-NM-10G" });
    await section.getByRole("button", { name: /^Add to Catalyst 3750-X 24/ }).click();
    await expect(section.getByRole("list", { name: "Modules on this device profile" })).toContainText("C3KX-NM-10G");

    // it can be moved from the keyboard: the new box takes focus on click, and Arrow keys nudge it
    const handle = section.getByRole("button", { name: /^C3KX-NM-10G, / });
    await handle.focus();
    await page.keyboard.press("ArrowLeft");
    await section.getByRole("button", { name: "Save modules" }).click();
    await expect(page.getByText("Modules saved: 1 placed.")).toBeVisible();
    expect(body).not.toBeNull();
    expect(body!.modules).toHaveLength(1);
    expect(body!.modules![0]).toMatchObject({ moduleId: MOD_ID });
    // the box keeps the module picture's proportions: a 2:1 picture on a 10:1 switch is five times as tall, as a fraction, as it is wide
    expect(body!.modules![0]!.h).toBeCloseTo(body!.modules![0]!.w * 5, 2);
  });

  test("a module's own page has no match box and no module section", async ({ page }) => {
    await signInAsTestUser(page);
    await fakeApi(page, [], [host([placed]), moduleModel]);
    await page.goto(`/device-profiles/${MOD_ID}`);
    await expect(page.getByRole("heading", { name: /C3KX-NM-10G/ })).toBeVisible();
    await expect(page.getByText("Add-on module", { exact: true }).first()).toBeVisible();
    await expect(page.getByLabel(/^Matches/)).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Add-on modules" })).toHaveCount(0);
  });
});
