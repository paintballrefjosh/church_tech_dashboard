import { test, expect, type Page } from "@playwright/test";

// The importer is driven by fake API answers (page.route), so nothing here writes to the real database or store.
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

const MODEL_ID = "88888888-8888-4888-8888-888888888888";
const IMAGE_ID = "99999999-9999-4999-8999-999999999999";

/** A grey switch front with a transparent margin round it, drawn in the page: the importer should cut the margin off. */
async function makePng(page: Page): Promise<Buffer> {
  const b64 = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 900;
    c.height = 140;
    const g = c.getContext("2d")!;
    g.fillStyle = "#c8ccd2";
    g.fillRect(50, 30, 800, 80);
    g.fillStyle = "#26292f";
    for (let i = 0; i < 12; i++) g.fillRect(90 + i * 60, 45, 44, 50);
    return c.toDataURL("image/png").split(",")[1]!;
  });
  return Buffer.from(b64, "base64");
}

async function fakeApi(page: Page) {
  const now = new Date().toISOString();
  const model: Record<string, unknown> = {
    id: MODEL_ID, name: "", match: [], portSide: "front", frontImageId: null, backImageId: null,
    frontWidth: null, frontHeight: null, backWidth: null, backHeight: null, ports: [], createdAt: now, updatedAt: now,
  };
  const uploads: Array<{ side: string; bytes: number }> = [];
  let png: Buffer | null = null;
  await page.route("**/api/me", async (route) => {
    const res = await route.fetch();
    const me = (await res.json()) as { permissions?: string[] };
    await route.fulfill({ response: res, json: { ...me, permissions: [...(me.permissions ?? []), "monitors:write:any"] } });
  });
  await page.route("**/api/switch-models", async (route) => {
    if (route.request().method() === "POST") {
      Object.assign(model, route.request().postDataJSON());
      return route.fulfill({ json: model });
    }
    return route.fulfill({ json: model.name ? [model] : [] });
  });
  await page.route(`**/api/switch-models/${MODEL_ID}/images/*`, async (route) => {
    if (route.request().method() === "POST") {
      const data = route.request().postDataBuffer()!;
      const start = data.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      png = data.subarray(start);
      const side = route.request().url().split("/").pop()!.split("?")[0]!;
      uploads.push({ side, bytes: png.length });
      Object.assign(model, { [`${side}ImageId`]: IMAGE_ID, [`${side}Width`]: png.readUInt32BE(16), [`${side}Height`]: png.readUInt32BE(20) });
      return route.fulfill({ json: model });
    }
    return route.fulfill({ body: png ?? Buffer.alloc(0), contentType: "image/png" });
  });
  return { model, uploads };
}

test.describe("Switch models: import from a file", () => {
  test("a picture file becomes the front of a new model, with its margin cut off", async ({ page }) => {
    await signInAsTestUser(page);
    const { model, uploads } = await fakeApi(page);
    await page.goto("/monitoring/network-cisco/models");
    const png = await makePng(page);

    await page.getByRole("button", { name: "Import from a file" }).click();
    await page.getByLabel("Choose a stencil or picture file").setInputFiles({ name: "Nexus 3064 front.png", mimeType: "image/png", buffer: png });
    await expect(page.getByText(/1 picture in Nexus 3064 front\.png/)).toBeVisible({ timeout: 15_000 });
    // one picture on its own is taken as the front, and the model is named after the file
    await expect(page.getByRole("button", { name: "front", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByLabel("Name")).toHaveValue("Nexus 3064 front");

    await page.getByRole("button", { name: "Create the model and import" }).click();
    await expect(page.getByRole("heading", { name: "Nexus 3064 front" })).toBeVisible({ timeout: 15_000 });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.side).toBe("front");
    // the 900 x 140 picture had an empty margin: what was stored is the 800 x 80 switch inside it
    expect(model.frontWidth).toBeLessThan(900);
    expect(model.frontHeight).toBeLessThan(140);
  });

  test("a file that is not a picture or a stencil says so", async ({ page }) => {
    await signInAsTestUser(page);
    await fakeApi(page);
    await page.goto("/monitoring/network-cisco/models");
    await page.getByRole("button", { name: "Import from a file" }).click();
    await page.getByLabel("Choose a stencil or picture file").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not a picture") });
    // Next adds its own role=alert route announcer, so pick the importer's message by its text.
    await expect(page.getByRole("alert").filter({ hasText: "not a kind of file" })).toBeVisible();
  });
});
