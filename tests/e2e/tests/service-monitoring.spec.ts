import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Service monitoring in the browser (docs/service-monitoring.md). Makes one SWITCHED-OFF infra host on 127.0.0.1 through the
// API, so the poller never reads it and every test run is refused before anything is contacted. Adds a service from the
// host page's dialog, opens its page, edits it, then walks the templates page (a built-in read-only, a typo in a new
// template caught as it is typed, the command confirmation), runs axe on each screen, and removes what it made.
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

const STAMP = Date.now();
const HOST = `[e2e] service host ${STAMP}`;

// With a dialog open, scan the dialog only: the page behind sits under the dark backdrop, which axe reads as low contrast.
async function axe(page: Page, include?: string) {
  const builder = new AxeBuilder({ page });
  if (include) builder.include(include);
  const r = await builder.withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

test("service monitoring: add a service from the host page, its page, and the templates", async ({ page }) => {
  await signInAsTestUser(page);
  const api = page.request;
  const res = await api.post("/api/infra/targets", { data: { name: HOST, os: "linux", host: "127.0.0.1", enabled: false } });
  expect(res.status()).toBeLessThan(300);
  const host = await res.json();
  let serviceId: string | null = null;
  try {
    await page.goto(`/monitoring/infra/${host.id}`);
    const section = page.getByTestId("host-services");
    await expect(section).toContainText("No services watched on this host");
    await section.getByRole("button", { name: "Add service" }).click();
    const dialog = page.getByTestId("service-form");
    await dialog.getByLabel("Template").selectOption("json-value");
    await expect(dialog.getByLabel("Name")).toHaveValue("JSON endpoint (one number)");
    await expect(dialog.getByRole("button", { name: "Add" })).toBeDisabled();
    await dialog.getByLabel(/^Address/).fill("http://127.0.0.1:9/status");
    await dialog.getByLabel(/^Path to the value/).fill("queue.depth");
    await dialog.getByLabel(/^Bearer token/).fill("e2e-secret-token");
    await axe(page, '[data-testid="service-form"]');

    // A test run aimed at this server is refused before anything is contacted, and says so.
    await dialog.getByRole("button", { name: "Test against this host" }).click();
    await expect(dialog.getByTestId("service-test-result")).toContainText("It would be marked down.");
    await expect(dialog.getByTestId("service-test-result")).toContainText(/not an address the dashboard may contact/);

    await dialog.getByLabel("Name").fill(`[e2e] queue ${STAMP}`);
    await dialog.getByRole("button", { name: "Add" }).click();
    await page.waitForURL(new RegExp(`/monitoring/infra/${host.id}/services/[0-9a-f-]{36}$`));
    serviceId = page.url().split("/").pop()!;
    await expect(page.getByRole("heading", { level: 1 })).toContainText(`[e2e] queue ${STAMP}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Switched off");
    await axe(page);

    const saved = await (await api.get(`/api/service-monitoring/instances/${serviceId}`)).json();
    expect(saved.secrets).toEqual({ token: "[saved]" });
    expect(JSON.stringify(saved)).not.toContain("e2e-secret-token");

    // Editing keeps the saved secret (an empty box shows "saved") and asks for nothing more.
    await page.getByRole("button", { name: "Edit" }).click();
    const edit = page.getByTestId("service-form");
    await expect(edit.getByLabel(/^Bearer token/)).toHaveAttribute("placeholder", /saved/);
    await edit.getByLabel("Check every (seconds)").fill("120");
    await edit.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("every 120 s")).toBeVisible();
    expect((await (await api.get(`/api/service-monitoring/instances/${serviceId}`)).json()).secrets).toEqual({ token: "[saved]" });

    await page.goto(`/monitoring/infra/${host.id}`);
    await expect(page.getByTestId("host-services")).toContainText(`[e2e] queue ${STAMP}`);

    // Templates: a built-in is read-only; a new template is checked as it is typed and asks for its commands.
    await page.goto("/monitoring/infra/service-templates");
    await expect(page.getByRole("link", { name: "HAProxy" })).toBeVisible();
    await axe(page);
    await page.getByRole("tab", { name: "Logins" }).click();
    await expect(page.getByRole("button", { name: "Add login" })).toBeVisible();
    await page.getByRole("tab", { name: "Templates" }).click();

    await page.getByRole("link", { name: "HAProxy" }).click();
    await page.waitForURL("**/service-templates/haproxy");
    await expect(page.getByTestId("template-yaml")).toHaveAttribute("readonly", "");
    await expect(page.getByText("The template reads correctly.")).toBeVisible();
    await axe(page);

    await page.goto("/monitoring/infra/service-templates");
    await page.getByRole("button", { name: "New template" }).click();
    const modal = page.getByRole("dialog");
    const yaml = modal.getByTestId("template-yaml");
    await yaml.fill("name: Broken\ninputs: []\ncollect: {}\nmetrics:\n  up: { from: nowhere, agg: count }\nchecks: []\n");
    await expect(modal.getByText('metric up: no collector "nowhere"')).toBeVisible();
    await yaml.fill("name: Nginx\ninputs: []\ncollect:\n  s: { transport: ssh, command: systemctl is-active nginx, parse: { type: lines } }\nmetrics:\n  up: { from: s, where: \"line == 'active'\", agg: count }\nchecks: []\n");
    await expect(modal.getByText("The template reads correctly.")).toBeVisible();
    await expect(modal.getByRole("list", { name: "Commands run on the host" })).toContainText("s: systemctl is-active nginx");
    await modal.getByLabel(/^Key/).fill(`e2e-${STAMP}`);
    const save = modal.getByRole("button", { name: "Save template" });
    await expect(save).toBeDisabled();
    await modal.getByLabel(/I have read these commands/).check();
    await save.click();
    await page.waitForURL(`**/service-templates/e2e-${STAMP}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Nginx");
  } finally {
    if (serviceId) await api.delete(`/api/service-monitoring/instances/${serviceId}`);
    await api.delete(`/api/service-monitoring/templates/e2e-${STAMP}`);
    await api.delete(`/api/infra/targets/${host.id}`);
  }
});

test("service monitoring: group services across hosts", async ({ page }) => {
  await signInAsTestUser(page);
  const api = page.request;
  const host = await (await api.post("/api/infra/targets", { data: { name: `${HOST} g`, os: "linux", host: "127.0.0.1", enabled: false } })).json();
  const group = `[e2e] group ${STAMP}`;
  let groupId: string | null = null;
  try {
    const made = await api.post("/api/service-monitoring/instances", {
      data: { targetId: host.id, templateKey: "json-value", name: `[e2e] member ${STAMP}`, inputs: { url: "http://127.0.0.1:9/x", path: "a" }, secrets: {} },
    });
    expect(made.status()).toBeLessThan(300);
    const inst = await made.json();

    await page.goto("/monitoring/infra");
    await page.getByRole("link", { name: "Service groups" }).click();
    await page.waitForURL("**/monitoring/infra/service-groups");
    await expect(page.getByRole("heading", { name: "Service groups" })).toBeVisible();
    await axe(page);

    await page.getByRole("button", { name: "New group" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name").fill(group);
    await dialog.getByLabel("Filter services").fill(`[e2e] member ${STAMP}`);
    await dialog.getByRole("checkbox", { name: new RegExp(`member ${STAMP}`) }).check();
    // The JSON template reports no state, so no role can be counted.
    await expect(dialog.getByRole("checkbox", { name: "Count a role" })).toBeDisabled();
    await dialog.getByLabel("Warn when a spare is lost for (minutes)").fill("20");
    await dialog.getByRole("checkbox", { name: /Show on the status page/ }).check();
    await dialog.getByLabel("Name on the status page").fill(`[e2e] shown ${STAMP}`);
    await axe(page, '[role="dialog"]');
    await dialog.getByRole("button", { name: "Save" }).click();
    await page.waitForURL(/\/monitoring\/infra\/service-groups\/[0-9a-f-]{36}$/);
    groupId = page.url().split("/").pop()!;
    await expect(page.getByRole("heading", { level: 1 })).toContainText(group);
    // Its only service is switched off (its host is): nothing to judge, and the member says so.
    await expect(page.getByText("Nothing to judge")).toBeVisible();
    await expect(page.getByRole("region", { name: "Services in the group" })).toContainText("not counted");
    await axe(page);
    await expect(page.getByTestId("group-availability")).toContainText(`on the status page as [e2e] shown ${STAMP}`);
    await expect(page.getByText("warn after 20 min without a spare")).toBeVisible();

    // The status page shows it under that name, and nothing of its services.
    await page.goto("/status");
    await expect(page.getByTestId("status-list")).toContainText(`[e2e] shown ${STAMP}`);
    await expect(page.getByTestId("status-list")).not.toContainText(`member ${STAMP}`);

    await page.goto(`/monitoring/infra/${host.id}/services/${inst.id}`);
    await expect(page.getByRole("link", { name: group })).toBeVisible();

    await page.goto(`/monitoring/infra/service-groups/${groupId}`);
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: "Delete" }).click();
    await page.waitForURL("**/monitoring/infra/service-groups");
    groupId = null;
    await expect(page.getByRole("link", { name: group })).toHaveCount(0);
  } finally {
    if (groupId) await api.delete(`/api/service-monitoring/groups/${groupId}`);
    await api.delete(`/api/infra/targets/${host.id}`);
  }
});
