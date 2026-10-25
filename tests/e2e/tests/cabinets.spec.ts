import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// The cabinet pages and the printable sheets are driven by fake API answers (page.route), so nothing here can touch a real
// cabinet or device. Set SHOTS=<folder> to also save screenshots of each page (used when changing how they look).
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

const RACK_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SW_ID = "44444444-4444-4444-8444-444444444444";
const HOST_ID = "66666666-6666-4666-8666-666666666666";
const MODEL_ID = "77777777-7777-4777-8777-777777777777";
const IMAGE_FRONT = "88888888-8888-4888-8888-888888888881";
const IMAGE_BACK = "88888888-8888-4888-8888-888888888882";
const NOW = new Date().toISOString();
const SHOTS = process.env.SHOTS;

const live = (over: Record<string, unknown>) => ({
  name: "x", hostname: null, ip: null, model: null, status: "unknown", missing: false, href: null, switchModelId: null, switchViewOff: false, ...over,
});

const rack = {
  id: RACK_ID, name: "Server room rack A", location: "Basement comms room", units: 24, notes: "Cold aisle faces the door.", createdAt: NOW, updatedAt: NOW,
  items: [
    { id: "b0000000-0000-4000-8000-000000000001", rackId: RACK_ID, sourceKind: "custom", sourceId: null, label: "Patch panel A", hostname: null, ip: null, style: "patch_panel", startU: 23, heightU: 1, modelId: null, notes: "",
      live: live({ name: "Patch panel A" }) },
    { id: "b0000000-0000-4000-8000-000000000002", rackId: RACK_ID, sourceKind: "cisco", sourceId: SW_ID, label: "core-sw01", hostname: "core-sw01", ip: "10.0.0.2", style: "switch", startU: 21, heightU: 1, modelId: null, notes: "",
      live: live({ name: "core-sw01", hostname: "core-sw01", ip: "10.0.0.2", model: "WS-C3850-48F-E", status: "up", href: `/monitoring/network-cisco/switches/${SW_ID}` }) },
    { id: "b0000000-0000-4000-8000-000000000003", rackId: RACK_ID, sourceKind: "infra", sourceId: HOST_ID, label: "docker01", hostname: "docker01.example.org", ip: "10.0.0.20", style: "server", startU: 15, heightU: 2, modelId: null, notes: "",
      live: live({ name: "docker01", hostname: "docker01.example.org", ip: "10.0.0.20", status: "up", href: `/monitoring/infra/${HOST_ID}` }) },
    { id: "b0000000-0000-4000-8000-000000000004", rackId: RACK_ID, sourceKind: "unifi", sourceId: "aa:bb:cc:00:11:22", label: "USW-Pro-48", hostname: "USW-Pro-48", ip: "10.0.0.3", style: "switch", startU: 12, heightU: 1, modelId: null, notes: "",
      live: live({ name: "USW-Pro-48", hostname: "USW-Pro-48", ip: "10.0.0.3", model: "US48PRO", status: "down", href: "/monitoring/network" }) },
    { id: "b0000000-0000-4000-8000-000000000005", rackId: RACK_ID, sourceKind: "custom", sourceId: null, label: "UPS", hostname: "ups01", ip: "10.0.0.50", style: "ups", startU: 1, heightU: 3, modelId: null, notes: "",
      live: live({ name: "UPS", hostname: "ups01", ip: "10.0.0.50" }) },
  ],
};

const model = {
  id: MODEL_ID, name: "Cisco Catalyst 3850-48", kind: "switch", match: ["C3850-48"], portSide: "front",
  frontImageId: IMAGE_FRONT, backImageId: IMAGE_BACK, frontWidth: 1930, frontHeight: 178, backWidth: 1930, backHeight: 178,
  ports: Array.from({ length: 24 }, (_, i) => ({ name: `Gi1/0/${i + 1}`, aliases: [], kind: "rj45", x: 0.2 + (i % 12) * 0.05, y: i < 12 ? 0.2 : 0.55, w: 0.04, h: 0.25 })),
  modules: [], createdAt: NOW, updatedAt: NOW,
};

/** A plain drawn picture of a switch face, made in the browser so no image file is needed. */
async function faceImage(page: Page, label: string): Promise<Buffer> {
  const b64 = await page.evaluate((text) => {
    const c = document.createElement("canvas");
    c.width = 1930;
    c.height = 178;
    const g = c.getContext("2d")!;
    g.fillStyle = "#cbd5e1";
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = "#0f172a";
    for (let i = 0; i < 24; i++) g.fillRect(386 + (i % 12) * 96, i < 12 ? 36 : 98, 77, 44);
    g.font = "bold 40px sans-serif";
    g.fillText(text, 30, 100);
    return c.toDataURL("image/png").split(",")[1]!;
  }, label);
  return Buffer.from(b64, "base64");
}

async function fakeApi(page: Page) {
  const front = await faceImage(page, "FRONT");
  const back = await faceImage(page, "BACK");
  await page.route("**/api/switch-models", (route) => route.fulfill({ json: [model] }));
  await page.route(`**/api/switch-models/${MODEL_ID}/images/front*`, (route) => route.fulfill({ body: front, contentType: "image/png" }));
  await page.route(`**/api/switch-models/${MODEL_ID}/images/back*`, (route) => route.fulfill({ body: back, contentType: "image/png" }));
  await page.route("**/api/racks", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: [{ ...rack, itemCount: rack.items.length, usedUnits: 9 }] })
      : route.fulfill({ status: 201, json: rack }),
  );
  await page.route(`**/api/racks/${RACK_ID}`, (route) => route.fulfill({ json: rack }));
  await page.route("**/api/racks/candidates", (route) =>
    route.fulfill({
      json: [
        { kind: "cisco", id: SW_ID, name: "core-sw01", hostname: "core-sw01", ip: "10.0.0.2", model: "WS-C3850-48F-E", style: "switch", placedIn: { rackId: RACK_ID, rackName: rack.name } },
        { kind: "cisco", id: "99999999-9999-4999-8999-999999999999", name: "edge-sw02", hostname: "edge-sw02", ip: "10.0.0.4", model: "WS-C3850-48F-E", style: "switch", placedIn: null },
      ],
    }),
  );
  // Show the write buttons whatever the test user's tier is: the page only reads this to decide what to offer.
  await page.route("**/api/me", async (route) => {
    const res = await route.fetch();
    const me = (await res.json()) as { permissions?: string[] };
    await route.fulfill({ response: res, json: { ...me, permissions: [...(me.permissions ?? []), "monitors:write:any"] } });
  });
}

async function axeClean(page: Page, where: string) {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
  const lines = result.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(" | ")}`);
  expect(lines, `axe on ${where}`).toEqual([]);
}

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

test.describe("Cabinets", () => {
  test("the list shows a card per cabinet with how full it is", async ({ page }) => {
    await signInAsTestUser(page);
    await fakeApi(page);
    await page.goto("/cabinets");
    const card = page.getByRole("link", { name: /Server room rack A/ });
    await expect(card).toContainText("5 items");
    await expect(card).toContainText("9 of 24U used");
    await shot(page, "cabinets-list");
    await axeClean(page, "/cabinets");
  });

  test("the elevation puts each item at its U, switches between front and rear, and lists hostnames and addresses", async ({ page }) => {
    await signInAsTestUser(page);
    await fakeApi(page);
    await page.goto(`/cabinets/${RACK_ID}`);
    const elevation = page.getByRole("group", { name: /Server room rack A, front view, 24U/ });
    await expect(elevation).toBeVisible();
    await expect(elevation.getByRole("button", { name: /core-sw01, U21/ })).toBeVisible();
    await expect(elevation.getByRole("button", { name: /docker01, U15-U16/ })).toBeVisible();
    await expect(elevation.getByRole("button", { name: /UPS, U1-U3/ })).toBeVisible();
    // Two units above and below the switch are free: a button to place something at each.
    await expect(elevation.getByRole("button", { name: "Add an item at U22" })).toBeVisible();
    // The switch gets its model's picture on the front and the other one on the rear.
    await expect(elevation.locator('img[src*="images/front"]')).toHaveCount(1);
    const table = page.getByRole("region", { name: "Items in this cabinet" });
    await expect(table).toContainText("docker01.example.org");
    await expect(table).toContainText("10.0.0.20");
    await shot(page, "cabinet-front");
    await axeClean(page, "cabinet front");

    await page.getByRole("button", { name: "Rear" }).click();
    await expect(page.getByRole("group", { name: /rear view/ })).toBeVisible();
    await expect(page.locator('img[src*="images/back"]')).toHaveCount(1);
    await expect(page.locator('img[src*="images/front"]')).toHaveCount(0);
    await shot(page, "cabinet-rear");
  });

  test("a switch's add-on module is drawn on its picture while the switch has the module's ports, on the side that has the ports", async ({ page }) => {
    const MOD_ID = "99999999-9999-4999-8999-999999999991";
    const MOD_IMG = "88888888-8888-4888-8888-888888888883";
    await signInAsTestUser(page);
    await fakeApi(page);
    const moduleModel = {
      ...model, id: MOD_ID, name: "C3KX-NM-10G", kind: "module", match: [], frontImageId: MOD_IMG, backImageId: null, frontWidth: 400, frontHeight: 150, backWidth: null, backHeight: null,
      ports: [{ name: "Te1/1/1", aliases: ["Gi1/1/1"], kind: "sfp", x: 0.1, y: 0.25, w: 0.2, h: 0.5 }],
    };
    const host = { ...model, modules: [{ id: "m1", moduleId: MOD_ID, x: 0.8, y: 0.2, w: 0.18, h: 0.6 }] };
    const withPorts = (portNames: string[]) => ({
      ...rack,
      items: rack.items.map((it) => (it.sourceKind === "cisco" ? { ...it, live: { ...it.live, portNames } } : it)),
    });
    const png = await faceImage(page, "MODULE");
    await page.route("**/api/switch-models", (route) => route.fulfill({ json: [host, moduleModel] }));
    await page.route(`**/api/switch-models/${MOD_ID}/images/front*`, (route) => route.fulfill({ body: png, contentType: "image/png" }));

    // The switch reports the module's port (by its alias): the module is drawn over the front.
    await page.route(`**/api/racks/${RACK_ID}`, (route) => route.fulfill({ json: withPorts(["Gi1/0/1", "Gi1/1/1"]) }));
    await page.goto(`/cabinets/${RACK_ID}`);
    const elevation = page.getByRole("group", { name: /front view/ });
    await expect(elevation.locator(`image[href*="${MODEL_ID}/images/front"]`)).toHaveCount(1);
    await expect(elevation.locator(`image[href*="${MOD_ID}/images/front"]`)).toHaveCount(1);
    await shot(page, "cabinet-front-module");
    await axeClean(page, "cabinet front with a module");

    // The module sits on the front picture only: the rear shows the plain back.
    await page.getByRole("button", { name: "Rear" }).click();
    await expect(page.getByRole("group", { name: /rear view/ })).toBeVisible();
    await expect(page.locator(`image[href*="${MOD_ID}/images/front"]`)).toHaveCount(0);
    await expect(page.locator('img[src*="images/back"]')).toHaveCount(1);

    // A switch without the module's ports is drawn as before.
    await page.route(`**/api/racks/${RACK_ID}`, (route) => route.fulfill({ json: withPorts(["Gi1/0/1", "Gi1/0/2"]) }));
    await page.goto(`/cabinets/${RACK_ID}`);
    await expect(page.getByRole("group", { name: /front view/ }).locator('img[src*="images/front"]')).toHaveCount(1);
    await expect(page.locator(`image[href*="${MOD_ID}/images/front"]`)).toHaveCount(0);
  });

  test("an empty slot opens the placement form with that U filled in; a device already in a cabinet cannot be picked", async ({ page }) => {
    await signInAsTestUser(page);
    await fakeApi(page);
    await page.goto(`/cabinets/${RACK_ID}`);
    await page.getByRole("button", { name: "Add an item at U8" }).click();
    const dialog = page.getByRole("dialog", { name: "Place an item" });
    await expect(dialog.getByLabel(/Lowest U/)).toHaveValue("8");
    await expect(dialog.getByRole("option", { name: /core-sw01.*already in Server room rack A/ })).toHaveAttribute("disabled", "");
    await dialog.getByLabel("Device *").selectOption({ label: "edge-sw02 (10.0.0.4)" });
    // The 3850's picture is 1930 x 178: one U.
    await expect(dialog.getByLabel("Height (U)")).toHaveValue("1");
    // A place that is taken says why and cannot be saved.
    await dialog.getByLabel(/Lowest U/).fill("21");
    await expect(dialog.getByRole("alert")).toContainText("U21 is already taken");
    await expect(dialog.getByRole("button", { name: "Place" })).toBeDisabled();
    await shot(page, "cabinet-add");
    await axeClean(page, "place dialog");
  });

  test("the printable page has the cabinet and a table whose rows are level with the items", async ({ page }) => {
    await signInAsTestUser(page);
    await fakeApi(page);
    await page.goto(`/cabinets/${RACK_ID}/print`);
    const sheet = page.getByRole("article", { name: "Printable sheet for Server room rack A" });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("heading", { name: "Server room rack A" })).toBeVisible();
    await expect(sheet).toContainText("docker01.example.org");
    await expect(sheet).toContainText("10.0.0.20");
    // No navigation or footer on the sheet.
    await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);

    // The table row of an item sits at the same height as the item drawn beside it.
    const box = async (locator: ReturnType<Page["locator"]>) => (await locator.first().boundingBox())!;
    const drawn = await box(sheet.locator(".rack-elevation img").first().locator("xpath=ancestor::div[contains(@class,'border-b')][1]"));
    const row = await box(sheet.getByText("core-sw01", { exact: true }).first().locator("xpath=ancestor::span[contains(@class,'border-b')][1]"));
    expect(Math.abs(drawn.y - row.y)).toBeLessThan(1.5);
    expect(Math.abs(drawn.height - row.height)).toBeLessThan(1.5);

    await shot(page, "cabinet-print-front");
    await page.getByRole("button", { name: "Front and rear" }).click();
    await expect(sheet.getByRole("group", { name: /rear view/ })).toBeVisible();
    await expect(sheet.getByRole("group", { name: /front view/ })).toBeVisible();
    await shot(page, "cabinet-print-both");
    await page.getByRole("checkbox", { name: "Pictures" }).uncheck();
    await expect(sheet.locator("img")).toHaveCount(0);
    await shot(page, "cabinet-print-nopics");
    await axeClean(page, "cabinet print");
  });
});

const SHEET = {
  kind: "cisco",
  device: { id: SW_ID, name: "core-sw01", ip: "10.0.0.2", model: "WS-C3850-48F-E", location: "Basement comms room", switchModelId: null, switchViewOff: false },
  generatedAt: NOW,
  ports: [
    { port: "Gi1/0/1", description: "Front desk phone", mode: "access", vlan: "20 Voice", subnet: "10.0.20.0/24", link: "up" },
    { port: "Gi1/0/2", description: "", mode: "access", vlan: "10 Staff", subnet: "10.0.10.0/24", link: "down" },
    { port: "Gi1/0/3", description: "Uplink to edge", mode: "trunk", vlan: "trunk, native 99 Mgmt; tagged 10 Staff, 20 Voice", subnet: "99: 10.0.99.0/24; 10: 10.0.10.0/24; 20: 10.0.20.0/24", link: "up" },
  ],
  notes: [],
};

test.describe("Port sheets", () => {
  test("a Cisco switch's sheet: picture first (front or back), then a row per port with VLAN and subnet", async ({ page }) => {
    await signInAsTestUser(page);
    await fakeApi(page);
    await page.route(`**/api/port-sheets/cisco/${SW_ID}`, (route) => route.fulfill({ json: SHEET }));
    await page.goto(`/print/cisco/${SW_ID}`);
    const sheet = page.getByRole("article", { name: "Port sheet for core-sw01" });
    await expect(sheet).toBeVisible();
    // The picture is above the table.
    const pic = await sheet.getByRole("img", { name: "Front of core-sw01" }).boundingBox();
    const table = await sheet.getByRole("table").boundingBox();
    expect(pic!.y + pic!.height).toBeLessThanOrEqual(table!.y + 1);
    await expect(sheet.getByRole("row", { name: /Gi1\/0\/1 Front desk phone 20 Voice 10\.0\.20\.0\/24/ })).toBeVisible();
    await expect(sheet.getByRole("row", { name: /Gi1\/0\/3 Uplink to edge trunk, native 99 Mgmt/ })).toBeVisible();
    // The model has port boxes on its front: they are numbered on the picture.
    await expect(sheet.getByText("24", { exact: true })).toBeVisible();
    await shot(page, "port-sheet-front");

    await page.getByRole("button", { name: "Back" }).click();
    await expect(sheet.getByRole("img", { name: "Back of core-sw01" })).toBeVisible();
    await expect(sheet.getByText("24", { exact: true })).toHaveCount(0); // the ports are on the front
    await shot(page, "port-sheet-back");
    await axeClean(page, "cisco port sheet");
  });

  test("a switch the controller does not list gives a plain message", async ({ page }) => {
    await signInAsTestUser(page);
    await fakeApi(page);
    await page.route("**/api/port-sheets/unifi/*", (route) => route.fulfill({ status: 404, json: { message: "The UniFi controller does not list that device" } }));
    await page.goto("/print/unifi/aa:bb:cc:00:11:22");
    await expect(page.getByRole("main").getByRole("alert")).toContainText("does not list that device");
  });
});
