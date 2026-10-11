import { test, expect, type Page } from "@playwright/test";

const TEST_USER = "regression-test@local";
const TEST_DEFAULT_PASSWORD = "regression-default-pwd";
const TEST_NEW_PASSWORD = "regression-changed-pwd-1";

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

async function openLook(page: Page) {
  await page.goto("/?theme=toward-sunday");
  await expect(page.locator('[data-look="toward-sunday"]')).toBeVisible();
}

test.describe("Home look: Toward Sunday", () => {
  test.describe.configure({ mode: "serial" });

  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${scheme} scheme`, () => {
      test.use({ colorScheme: scheme });

      test(`renders the week rail, now marker and readiness strip (${scheme})`, async ({ page, context }) => {
        await signInAsTestUser(page);
        await context.addInitScript((t) => {
          try {
            localStorage.setItem("theme", t);
          } catch {
            /* storage unavailable */
          }
        }, scheme);
        await openLook(page);

        // Seven day columns: six equal ones plus the service day, or seven equal ones with no service this week.
        await expect(page.getByTestId("week-day")).toHaveCount(7);
        await expect(page.locator('[data-testid="week-day"][data-today="true"]')).toHaveCount(1);
        await expect(page.getByTestId("week-now")).toBeAttached();
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

        // The readiness strip is hidden when its section is not available, so only check what is shown.
        const strip = page.getByTestId("readiness-strip");
        if (await strip.count()) {
          await expect(strip).toBeVisible();
          expect(await strip.locator("[data-check]").count()).toBeGreaterThan(0);
        }

        const dark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
        expect(dark).toBe(scheme === "dark");
        const bg = await page.locator('[data-look="toward-sunday"]').evaluate((el) => getComputedStyle(el).backgroundColor);
        expect(bg).toBe(scheme === "dark" ? "rgb(13, 21, 38)" : "rgb(244, 246, 250)");
      });
    });
  }

  test("has no horizontal page overflow at 390 px and the rail scrolls inside its card", async ({ page }) => {
    await signInAsTestUser(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await openLook(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const scroll = page.getByTestId("week-rail-scroll");
    await expect(scroll).toBeVisible();
    const scrollable = await scroll.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(scrollable).toBe(true);
  });
});
