import { test, expect, type Page } from "@playwright/test";

// The switch model pages are driven by fake API answers (page.route), so nothing here writes to the real database or store.
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

const MODEL_ID = "66666666-6666-4666-8666-666666666666";
const IMAGE_ID = "77777777-7777-4777-8777-777777777777";

/** A synthetic switch front: grey body with two rows of dark sockets that have lighter contacts inside, drawn in the page. */
async function makePhoto(page: Page): Promise<Buffer> {
  const b64 = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 1600;
    c.height = 160;
    const g = c.getContext("2d")!;
    g.fillStyle = "#c8ccd2";
    g.fillRect(0, 0, 1600, 160);
    for (let col = 0; col < 12; col++) {
      for (let row = 0; row < 2; row++) {
        const x = 120 + col * 60;
        const y = 30 + row * 60;
        g.fillStyle = "#26292f";
        g.fillRect(x, y, 50, 44);
        g.fillStyle = "#9096a0";
        for (let i = 0; i < 8; i++) g.fillRect(x + 6 + i * 5.5, y + 5, 2, 14);
      }
    }
    return c.toDataURL("image/png").split(",")[1]!;
  });
  return Buffer.from(b64, "base64");
}

interface FakeModel extends Record<string, unknown> {
  ports: Array<{ name: string; kind: string; x: number; y: number }>;
}

async function fakeApi(page: Page) {
  const now = new Date().toISOString();
  let png: Buffer | null = null;
  const model: FakeModel = {
    id: MODEL_ID, name: "E2E Model", match: ["E2E-1"], portSide: "front",
    frontImageId: null, backImageId: null, frontWidth: null, frontHeight: null, backWidth: null, backHeight: null,
    ports: [], createdAt: now, updatedAt: now,
  };
  await page.route("**/api/me", async (route) => {
    const res = await route.fetch();
    const me = (await res.json()) as { permissions?: string[] };
    await route.fulfill({ response: res, json: { ...me, permissions: [...(me.permissions ?? []), "monitors:write:any"] } });
  });
  await page.route("**/api/switch-models", (route) => route.fulfill({ json: [model] }));
  await page.route(`**/api/switch-models/${MODEL_ID}`, async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    Object.assign(model, body);
    await route.fulfill({ json: model });
  });
  await page.route(`**/api/switch-models/${MODEL_ID}/images/front*`, async (route) => {
    if (route.request().method() === "POST") {
      const data = route.request().postDataBuffer()!;
      png = data.subarray(data.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47])));
      Object.assign(model, { frontImageId: IMAGE_ID, frontWidth: png.readUInt32BE(16), frontHeight: png.readUInt32BE(20) });
      return route.fulfill({ json: model });
    }
    return route.fulfill({ body: png!, contentType: "image/png" });
  });
  return model;
}

test.describe("Switch models", () => {
  test("lists models and links to the editor", async ({ page }) => {
    await signInAsTestUser(page);
    await fakeApi(page);
    await page.goto("/monitoring/network-cisco/models");
    await expect(page.getByRole("link", { name: "Switch models" })).toBeVisible();
    await expect(page.getByRole("link", { name: "E2E Model" })).toBeVisible();
    await expect(page.getByRole("button", { name: "New switch model" })).toBeVisible();
  });

  test("uploads a picture, finds the sockets automatically, numbers them, and saves", async ({ page }) => {
    await signInAsTestUser(page);
    const model = await fakeApi(page);
    await page.goto(`/monitoring/network-cisco/models/${MODEL_ID}`);
    const photo = await makePhoto(page);

    await page.getByLabel("Upload the front picture").setInputFiles({ name: "front.png", mimeType: "image/png", buffer: photo });
    await expect(page.getByRole("group", { name: "Port layout" })).toBeVisible();

    await page.getByRole("button", { name: "Auto", exact: true }).click();
    await page.getByRole("button", { name: "Find sockets" }).click();
    await expect(page.getByText(/24 sockets about/)).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: /Add 24 ports/ }).click();

    const list = page.getByRole("list", { name: "Ports" });
    await expect(list.getByRole("listitem")).toHaveCount(24);
    await expect(list).toContainText("Gi1/0/1");
    await expect(list).toContainText("Gi1/0/24");

    // 1 sits above 2 and 3 is to the right of 1
    const at = async (n: string) => (await page.locator(`[data-uid][data-port="${n}"]`).boundingBox())!;
    const [p1, p2, p3] = [await at("Gi1/0/1"), await at("Gi1/0/2"), await at("Gi1/0/3")];
    expect(p2.y).toBeGreaterThan(p1.y);
    expect(p3.x).toBeGreaterThan(p1.x);

    // a box can be dragged, and undo puts it back
    await page.locator('[data-uid][data-port="Gi1/0/1"]').click();
    const from = await at("Gi1/0/1");
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 25, from.y + from.height / 2, { steps: 5 });
    await page.mouse.up();
    expect((await at("Gi1/0/1")).x - from.x).toBeGreaterThan(15);
    await page.getByRole("button", { name: "Undo" }).click();
    expect(Math.abs((await at("Gi1/0/1")).x - from.x)).toBeLessThan(1);

    await page.getByRole("button", { name: "Save layout" }).click();
    await expect(page.getByText("Layout saved: 24 ports.")).toBeVisible();
    expect(model.ports.length).toBe(24);
    expect(model.ports.find((p) => p.name === "Gi1/0/2")!.y).toBeGreaterThan(model.ports.find((p) => p.name === "Gi1/0/1")!.y);

    // the preview draws the saved layout the way a switch page would
    await expect(page.getByRole("region", { name: /, ports$/ }).locator("[data-port]")).toHaveCount(24);
  });
});
