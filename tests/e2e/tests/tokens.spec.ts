import { test, expect, type Page } from "@playwright/test";

const TEST_USER = "regression-test@local";
const TEST_DEFAULT_PASSWORD = "regression-default-pwd";
const TEST_NEW_PASSWORD = "regression-changed-pwd-1";

// Named tokens.spec.ts, not api-tokens: files run alphabetically and 00-auth.spec.ts
// must see the test user before any spec changes its default password.
test.describe.configure({ mode: "serial" });

async function signInAsTestUser(page: Page) {
  async function attempt(password: string) {
    await page.goto("/signin");
    await page.getByLabel("Email or username").fill(TEST_USER);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(
      (u) => !u.pathname.startsWith("/signin") || u.search.includes("error="),
      { timeout: 15_000 },
    );
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

test.describe("API tokens", () => {
  test.beforeEach(async ({ page }) => {
    await signInAsTestUser(page);
  });

  test("the profile page links to the token page", async ({ page }) => {
    await page.goto("/me");
    await page.getByRole("link", { name: "Manage API tokens" }).click();
    await expect(page).toHaveURL(/\/me\/api-tokens$/);
    await expect(page.getByRole("heading", { name: "API tokens" })).toBeVisible();
  });

  test("create a token, see it once, use it, revoke it", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const name = `e2e token ${Date.now()}`;
    await page.goto("/me/api-tokens");

    await page.getByRole("button", { name: "New token" }).click();
    const form = page.getByTestId("api-token-form");
    await form.getByLabel("Name").fill(name);
    // Defaults: read-only, all modules, the default lifetime.
    await expect(form.getByLabel("Read-only")).toBeChecked();
    await form.getByRole("button", { name: "Create token" }).click();

    const reveal = page.getByTestId("api-token-reveal");
    await expect(reveal).toBeVisible();
    const token = await reveal.getByLabel("New API token").inputValue();
    expect(token).toMatch(/^cdt_[A-Za-z0-9_-]{43}$/);
    await expect(reveal.getByText(`/api/v1/me`)).toBeVisible();

    await reveal.getByRole("button", { name: "Copy", exact: true }).click();
    await expect(reveal.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(token);

    // The token works as a bearer credential, and is read-only.
    const me = await page.request.get("/api/v1/me", { headers: { authorization: `Bearer ${token}` } });
    expect(me.status()).toBe(200);
    expect((await me.json()).email).toBe(TEST_USER);
    const write = await page.request.post("/api/v1/notes", {
      headers: { authorization: `Bearer ${token}` },
      data: { title: "nope", body: "" },
    });
    expect(write.status()).toBe(403);

    // Dismissed, the secret is gone for good: only the prefix stays listed.
    await reveal.getByRole("button", { name: /Done/ }).click();
    await expect(reveal).toHaveCount(0);
    const row = page.getByRole("row", { name: new RegExp(name) });
    await expect(row).toContainText(token.slice(0, 8));
    await expect(row).toContainText("active");
    await page.reload();
    await expect(page.getByText(token)).toHaveCount(0);

    page.once("dialog", (d) => void d.accept());
    await page.getByRole("row", { name: new RegExp(name) }).getByRole("button", { name: "Revoke" }).click();
    await expect(page.getByRole("row", { name: new RegExp(name) })).toContainText("revoked");

    const after = await page.request.get("/api/v1/me", { headers: { authorization: `Bearer ${token}` } });
    expect(after.status()).toBe(401);
  });

  test("the equipment level is chosen on the form and only that token reaches equipment routes", async ({ page }) => {
    // POST /ups/:id/poll is @OperationalOnly. The id matches no device, so a token that gets past the guard
    // answers 404 and nothing on the network is touched.
    const poll = "/api/v1/ups/00000000-0000-4000-8000-000000000000/poll";
    const stamp = Date.now();
    const names = { write: `e2e write ${stamp}`, equipment: `e2e equipment ${stamp}` };
    await page.goto("/me/api-tokens");

    async function create(name: string, access: string | RegExp): Promise<string> {
      await page.getByRole("button", { name: "New token" }).click();
      const form = page.getByTestId("api-token-form");
      await form.getByLabel("Name").fill(name);
      await form.getByLabel(access).check();
      await form.getByRole("button", { name: "Create token" }).click();
      const reveal = page.getByTestId("api-token-reveal");
      await expect(reveal).toBeVisible();
      const token = await reveal.getByLabel("New API token").inputValue();
      await reveal.getByRole("button", { name: /Done/ }).click();
      return token;
    }
    const post = (token: string) =>
      page.request.post(poll, { headers: { authorization: `Bearer ${token}` }, data: {} });

    // The warning about live equipment appears for that level only.
    await page.getByRole("button", { name: "New token" }).click();
    const form = page.getByTestId("api-token-form");
    const warning = form.getByText(/can change things people see and depend on right now/);
    await expect(warning).toHaveCount(0);
    await form.getByLabel("Read, write and equipment").check();
    await expect(warning).toBeVisible();
    await form.getByLabel("Read and write").check();
    await expect(warning).toHaveCount(0);
    await form.getByRole("button", { name: "Cancel" }).click();

    const writeToken = await create(names.write, "Read and write");
    const equipmentToken = await create(names.equipment, "Read, write and equipment");
    try {
      await expect(page.getByRole("row", { name: new RegExp(names.equipment) })).toContainText("Read, write and equipment");
      await expect(page.getByRole("row", { name: new RegExp(names.write) })).not.toContainText("equipment");

      const refused = await post(writeToken);
      expect(refused.status()).toBe(403);
      expect(JSON.stringify(await refused.json())).toMatch(/operational/);
      expect((await post(equipmentToken)).status()).toBe(404);
    } finally {
      for (const name of Object.values(names)) {
        const row = page.getByRole("row", { name: new RegExp(name) });
        if ((await row.count()) === 0) continue;
        page.once("dialog", (d) => void d.accept());
        await row.getByRole("button", { name: "Revoke" }).click();
        await expect(row).toContainText("revoked");
      }
    }
    expect((await post(equipmentToken)).status()).toBe(401);
  });

  test("an admin sees the token in /admin/api-tokens", async ({ page }) => {
    await page.goto("/admin/api-tokens?status=revoked");
    await expect(page.getByRole("heading", { name: "API tokens" })).toBeVisible();
    await expect(page.getByTestId("api-token-table")).toContainText(TEST_USER);
  });
});
