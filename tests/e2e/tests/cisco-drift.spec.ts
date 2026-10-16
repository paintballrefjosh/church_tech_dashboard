import { test, expect, type Page } from "@playwright/test";

// The drift page is driven by fake API answers (page.route), so nothing here can reach a real switch.
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

const ROW = (n: number, switchId: string, switchHostname: string, portId: string) => ({
  id: `11111111-1111-4111-8111-00000000000${n}`,
  switchId,
  switchHostname,
  portId,
  field: "speed",
  expected: "1000",
  observed: "100",
  detectedAt: new Date().toISOString(),
  resolvedAt: null,
});
const SW_A = "22222222-2222-4222-8222-222222222222";
const SW_B = "33333333-3333-4333-8333-333333333333";

test.describe("Cisco drift push", () => {
  test("shows a spinner while pushes are in flight, and lets several run at once", async ({ page }) => {
    await signInAsTestUser(page);
    let rows = [ROW(1, SW_A, "Fake-SW01", "Gi1/0/9"), ROW(2, SW_B, "Fake-SW02", "Gi1/0/3"), ROW(3, SW_A, "Fake-SW01", "Gi1/0/4")];
    await page.route("**/api/cisco/drift?*", (route) => route.fulfill({ json: { rows, total: rows.length } }));
    const releases: Record<string, () => void> = {};
    const started: string[] = [];
    await page.route("**/api/cisco/switches/*/drift/*/push", async (route) => {
      const id = route.request().url().split("/drift/")[1]!.split("/")[0]!;
      started.push(id);
      await new Promise<void>((resolve) => (releases[id] = resolve));
      rows = rows.filter((r) => r.id !== id);
      await route.fulfill({ json: { ok: true, count: 1 } });
    });

    await page.goto("/monitoring/network-cisco/drift");
    const rowFor = (port: string) => page.getByRole("row").filter({ hasText: port });
    await expect(rowFor("Gi1/0/9")).toBeVisible();

    // Start two pushes without waiting for the first: both are under way, each on its own row.
    await rowFor("Gi1/0/9").getByRole("button", { name: "Push" }).click();
    await rowFor("Gi1/0/3").getByRole("button", { name: "Push" }).click();
    await expect.poll(() => started.length).toBe(2);
    for (const port of ["Gi1/0/9", "Gi1/0/3"]) {
      const working = rowFor(port).getByRole("button", { name: /Pushing/ });
      await expect(working).toBeVisible();
      await expect(working.locator("svg.animate-spin")).toHaveCount(1);
      await expect(rowFor(port).getByRole("button", { name: "Accept" })).toBeDisabled();
    }
    await expect(page.getByRole("status").filter({ hasText: "Pushing speed on Gi1/0/9 to Fake-SW01" })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Pushing speed on Gi1/0/3 to Fake-SW02" })).toBeVisible();
    // A row nobody touched is still usable.
    await expect(rowFor("Gi1/0/4").getByRole("button", { name: "Push" })).toBeEnabled();

    // They finish in the other order; each reports on its own, as a toast in the lower right.
    releases[ROW(2, SW_B, "", "").id]!();
    const stack = page.getByTestId("toast-stack");
    const toastB = stack.getByRole("button", { name: "Pushed speed on Gi1/0/3 to Fake-SW02." });
    await expect(toastB).toBeVisible();
    const box = (await toastB.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.x + box.width).toBeGreaterThan(viewport.width - 40);
    expect(box.y + box.height).toBeGreaterThan(viewport.height - 40);
    await expect(rowFor("Gi1/0/9").getByRole("button", { name: /Pushing/ })).toBeVisible();

    releases[ROW(1, SW_A, "", "").id]!();
    const toastA = stack.getByRole("button", { name: "Pushed speed on Gi1/0/9 to Fake-SW01." });
    await expect(toastA).toBeVisible();
    await expect(toastB).toBeVisible();
    await expect(page.locator("svg.animate-spin")).toHaveCount(0);
    await expect(rowFor("Gi1/0/9")).toHaveCount(0);

    // A click dismisses one at once; the other leaves by itself after 5 seconds.
    await toastA.click();
    await expect(toastA).toHaveCount(0);
    await expect(toastB).toBeVisible();
    await expect(toastB).toHaveCount(0, { timeout: 7000 });
  });

  test("a failed push says why, as a toast", async ({ page }) => {
    await signInAsTestUser(page);
    const rows = [ROW(1, SW_A, "Fake-SW01", "Gi1/0/9")];
    await page.route("**/api/cisco/drift?*", (route) => route.fulfill({ json: { rows, total: rows.length } }));
    await page.route("**/api/cisco/switches/*/drift/*/push", (route) =>
      route.fulfill({ status: 500, json: { message: "Another change to this switch is still running" } }),
    );
    await page.goto("/monitoring/network-cisco/drift");
    await page.getByRole("button", { name: "Push" }).click();
    await expect(
      page.getByTestId("toast-stack").getByRole("button", { name: /Push of speed on Gi1\/0\/9 on Fake-SW01 failed: Another change/ }),
    ).toBeVisible();
  });
});
