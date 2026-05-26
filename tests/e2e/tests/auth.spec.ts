import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";

function getBootstrapCreds() {
  if (process.env.BOOTSTRAP_ADMIN_EMAIL && process.env.BOOTSTRAP_ADMIN_PASSWORD) {
    return {
      email: process.env.BOOTSTRAP_ADMIN_EMAIL,
      password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
    };
  }
  const out = execFileSync(
    "docker",
    [
      "compose",
      "-f",
      "infra/docker-compose.yml",
      "exec",
      "-T",
      "api",
      "cat",
      "/tmp/bootstrap-credentials.txt",
    ],
    { encoding: "utf8", cwd: process.env.REPO_ROOT ?? process.cwd() }
  );
  const email = out.match(/email:\s+(\S+)/)?.[1];
  const password = out.match(/password:\s+(\S+)/)?.[1];
  if (!email || !password) throw new Error("could not read bootstrap creds");
  return { email, password };
}

test.describe("Phase 0 — auth + dashboard shell", () => {
  test("unauthed visit redirects to /signin", async ({ page }) => {
    const response = await page.goto("/");
    expect(page).toHaveURL(/\/signin/);
    expect(response?.status()).toBeLessThan(400);
  });

  test("sign-in page renders both providers when configured", async ({ page }) => {
    await page.goto("/signin");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
  });

  test("theme toggle switches between light and dark", async ({ page }) => {
    await page.goto("/signin");
    // Ensure we start in a known state by setting to light
    await page.emulateMedia({ colorScheme: "light" });
    await page.reload();
    const html = page.locator("html");
    // Click the toggle to flip
    const toggle = page.getByLabel("Toggle theme");
    await expect(toggle).toBeVisible();
    const before = (await html.getAttribute("class")) ?? "";
    await toggle.click();
    await expect(html).not.toHaveAttribute("class", before);
  });

  test("local sign-in with bootstrap creds reaches the dashboard", async ({ page }) => {
    const { email, password } = getBootstrapCreds();
    await page.goto("/signin");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await Promise.all([
      page.waitForURL((url) => !url.pathname.startsWith("/signin"), { timeout: 15_000 }),
      page.getByRole("button", { name: "Sign in" }).click(),
    ]);
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
    await expect(page.getByText(email)).toBeVisible();
  });

  test("sign-out returns to /signin", async ({ page }) => {
    const { email, password } = getBootstrapCreds();
    await page.goto("/signin");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await Promise.all([
      page.waitForURL((url) => !url.pathname.startsWith("/signin"), { timeout: 15_000 }),
      page.getByRole("button", { name: "Sign in" }).click(),
    ]);
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL(/\/signin/);
  });
});
