import { test, expect, type Page } from "@playwright/test";

// These pages are driven by fake API answers (page.route), so nothing here can reach a real switch.
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


const SW1 = "22222222-2222-4222-8222-222222222222";
const SW2 = "33333333-3333-4333-8333-333333333333";
const SWITCH = (id: string, hostname: string) => ({
  id,
  hostname,
  ipAddress: "10.0.0.1",
  username: "x",
  model: null,
  location: null,
  reachable: true,
  uptime: "1 day",
  lastPolledAt: null,
  lastError: null,
  configDrift: false,
  checkPortState: true,
  alertPrefs: {},
  hasPassword: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});
const on = (switchId: string, hostname: string, state: string, over: Record<string, unknown> = {}) => ({
  switchId,
  hostname,
  vlanName: state === "missing" ? null : "x",
  vlanStatus: state === "missing" ? null : "active",
  desired: state !== "extra",
  desiredName: state === "extra" ? null : "x",
  state,
  ...over,
});
const VLANS = [
  { vlanId: 1, nameConflict: false, managed: false, switches: [on(SW1, "Fake-SW01", "in_sync", { vlanName: "default", desiredName: null, desired: false })] },
  { vlanId: 10, nameConflict: false, managed: true, switches: [on(SW1, "Fake-SW01", "in_sync", { vlanName: "servers", desiredName: "servers" }), on(SW2, "Fake-SW02", "in_sync", { vlanName: "servers", desiredName: "servers" })] },
  { vlanId: 40, nameConflict: false, managed: true, switches: [on(SW1, "Fake-SW01", "missing", { desiredName: "cameras" })] },
  { vlanId: 50, nameConflict: false, managed: true, switches: [on(SW2, "Fake-SW02", "extra", { vlanName: "old" })] },
  { vlanId: 60, nameConflict: false, managed: true, switches: [on(SW1, "Fake-SW01", "name", { vlanName: "lab", desiredName: "labs" })] },
];

test.describe("Cisco VLAN page", () => {
  test("shows how each switch compares, and adds, edits and deletes through the API", async ({ page }) => {
    await signInAsTestUser(page);
    await page.route("**/api/cisco/vlans", (route) => (route.request().method() === "GET" ? route.fulfill({ json: VLANS }) : route.fallback()));
    await page.route("**/api/cisco/switches", (route) => route.fulfill({ json: [SWITCH(SW1, "Fake-SW01"), SWITCH(SW2, "Fake-SW02")] }));
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    await page.route("**/api/cisco/vlans/*", async (route) => {
      const req = route.request();
      calls.push({ method: req.method(), url: new URL(req.url()).pathname, body: req.postDataJSON() });
      if (req.method() === "DELETE" && req.url().endsWith("/10")) {
        return route.fulfill({ status: 409, json: { message: "VLAN 10 is still in use: Fake-SW01 (Gi1/0/5 is an access port in it)" } });
      }
      return route.fulfill({ json: { vlanId: 70, created: ["Fake-SW01"], renamed: [], removed: [], unchanged: [] } });
    });

    await page.goto("/monitoring/network-cisco/vlans");
    const row = (id: string) => page.getByRole("row").filter({ has: page.getByText(id, { exact: true }) });
    await expect(row("40")).toContainText("Fake-SW01 (to add)");
    await expect(row("50")).toContainText("Fake-SW02 (not wanted)");
    await expect(row("60")).toContainText("Fake-SW01 (rename)");
    await expect(row("10")).not.toContainText("(");
    await expect(row("1")).toContainText("built in");
    await expect(page.getByText("3 VLANs differ from the wanted config")).toBeVisible();

    // Add: a reserved id is refused before anything is sent; a good one goes to the API with the ticked switches.
    await page.getByRole("button", { name: "Add VLAN" }).click();
    const modal = page.getByRole("dialog").or(page.locator("div.fixed").filter({ hasText: "Switches that should have this VLAN" }));
    await modal.getByLabel("VLAN ID").fill("1003");
    await modal.getByRole("button", { name: "Add VLAN" }).click();
    await expect(modal.getByText(/not 1002-1005/)).toBeVisible();
    expect(calls).toHaveLength(0);
    await modal.getByLabel("VLAN ID").fill("70");
    await modal.getByLabel("Name").fill("cams");
    await modal.getByLabel("Fake-SW02").uncheck();
    await modal.getByRole("button", { name: "Add VLAN" }).click();
    await expect(page.getByTestId("toast-stack").getByRole("button", { name: /VLAN 70: added on 1\. Push it from the Drift log/ })).toBeVisible();
    expect(calls[0]).toEqual({ method: "PUT", url: "/api/cisco/vlans/70", body: { name: "cams", switchIds: [SW1] } });

    // Edit: the id is fixed, the wanted switches are ticked, the name is the wanted one.
    await row("10").getByRole("button", { name: "Edit" }).click();
    await expect(modal.getByLabel("VLAN ID")).toBeDisabled();
    await expect(modal.getByLabel("Name")).toHaveValue("servers");
    await expect(modal.getByLabel("Fake-SW01")).toBeChecked();
    await expect(modal.getByLabel("Fake-SW02")).toBeChecked();
    await modal.getByLabel("Name").fill("servers_new");
    await modal.getByRole("button", { name: "Save" }).click();
    await expect.poll(() => calls.length).toBe(2);
    expect(calls[1]).toEqual({ method: "PUT", url: "/api/cisco/vlans/10", body: { name: "servers_new", switchIds: [SW1, SW2] } });

    // Delete: the server's reason for refusing is shown.
    await row("10").getByRole("button", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).last().click();
    await expect(page.getByTestId("toast-stack").getByRole("button", { name: /still in use: Fake-SW01 \(Gi1\/0\/5 is an access port in it\)/ })).toBeVisible();
  });
});

test.describe("Cisco port editor VLAN pickers", () => {
  test("offers the switch's own VLANs and composes a trunk list", async ({ page }) => {
    await signInAsTestUser(page);
    const port = (over: Record<string, unknown>) => ({
      id: "44444444-4444-4444-8444-444444444444",
      portId: "Gi1/0/1",
      description: "",
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
      ...over,
    });
    await page.route(`**/api/cisco/switches/${SW1}`, (route) => route.fulfill({ json: SWITCH(SW1, "Fake-SW01") }));
    await page.route(`**/api/cisco/switches/${SW1}/ports`, (route) => route.fulfill({ json: [port({})] }));
    await page.route(`**/api/cisco/switches/${SW1}/vlans`, (route) =>
      route.fulfill({ json: [{ vlanId: 1, name: "default" }, { vlanId: 10, name: "servers" }, { vlanId: 30, name: "printers" }, { vlanId: 40, name: "cameras" }] }),
    );
    await page.goto(`/monitoring/network-cisco/switches/${SW1}`);
    // exact: the switch's own "Edit switch" button comes first on the page and would match a loose "Edit".
    await page.getByRole("button", { name: "Edit", exact: true }).first().click();
    const modal = page.locator("div.fixed").filter({ hasText: "Edit Gi1/0/1" });

    const access = modal.getByLabel("Access VLAN");
    await expect(access.locator("option")).toHaveText(["1 · default", "10 · servers", "30 · printers", "40 · cameras"]);
    await expect(access).toHaveValue("10");

    await modal.getByLabel("Mode").selectOption("trunk");
    await expect(modal.getByLabel("Native VLAN").locator("option")).toHaveCount(4);
    await expect(modal.getByLabel("All VLANs")).toBeChecked();
    await modal.getByLabel("Selected VLANs").check();
    // Switching to a list starts with every VLAN the switch has; untick one, add others by hand.
    await expect(modal.getByText("Sends: 1,10,30,40")).toBeVisible();
    await modal.getByRole("checkbox", { name: "40 · cameras" }).uncheck();
    await modal.getByLabel(/Other VLANs/).fill("500,600-602");
    await expect(modal.getByText("Sends: 1,10,30,500,600-602")).toBeVisible();
    await modal.getByLabel("All VLANs").check();
    await expect(modal.getByLabel("Selected VLANs")).not.toBeChecked();
  });
});
