import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const TEST_USER = "regression-test@local";
const TEST_DEFAULT_PASSWORD = "regression-default-pwd";
const TEST_NEW_PASSWORD = "regression-changed-pwd-1";

// Named zz- so it runs after auth.spec.ts has changed the test user's password (like the other specs, it signs in with the
// changed one first). Two parts:
//  1. An axe-core sweep over every screen a person can reach (and the menus and dialogs that open on them), in the light and
//     the dark scheme, on a desktop and a phone-sized window. axe finds contrast, names, roles, landmarks, duplicate ids and
//     heading order: roughly a third of what can go wrong. The test fails on ANY violation, so a new screen cannot add one.
//  2. Keyboard tests for what axe cannot see: the skip link, and where focus goes when the palette and menus open and close.
// A violation that cannot be fixed (a third-party widget) is named in ACCEPTED with the reason, never silenced wholesale.
test.describe.configure({ mode: "serial" });

/** rule id -> why it is accepted. Empty on purpose. */
const ACCEPTED: Record<string, string> = {};

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

/** Screens with no id in the address. Detail pages are added from rows that exist (see `detailRoutes`). */
const ROUTES = [
  "/", "/activity", "/notifications", "/notes", "/tickets", "/tickets/new", "/tickets/canned-replies",
  "/wiki", "/wiki/new", "/wiki/review", "/wiki/templates", "/wiki/import",
  "/checklists", "/printers", "/propresenter", "/planning-center", "/dns", "/ipam", "/cabinets", "/status",
  "/monitoring", "/monitoring/new", "/monitoring/infra", "/monitoring/infra/new", "/monitoring/network", "/monitoring/ups", "/monitoring/alert-channels", "/renewals", "/monitoring/network/vouchers", "/reports/monthly",
  "/monitoring/network-cisco", "/monitoring/network-cisco/backups", "/monitoring/network-cisco/drift",
  "/monitoring/network-cisco/lookup", "/monitoring/network-cisco/topology", "/monitoring/network-cisco/vlans",
  "/me", "/me/security", "/me/api-tokens",
  "/admin", "/admin/users", "/admin/groups", "/admin/permissions", "/admin/tags", "/admin/ticket-categories", "/admin/api-tokens",
  "/admin/audit", "/admin/backups", "/admin/cluster", "/admin/security", "/admin/settings", "/admin/planning-center",
  "/admin/checklists", "/admin/checklists/stations", "/admin/checklists/services", "/admin/checklists/reports",
];

/** A list screen and the pattern of the links on it that lead to a detail screen: the first one found is scanned. */
const DETAILS: Array<{ list: string; href: RegExp; suffixes?: string[] }> = [
  { list: "/tickets", href: /^\/tickets\/[0-9a-f-]{36}$/ },
  { list: "/wiki", href: /^\/wiki\/[0-9a-f-]{36}$/, suffixes: ["/edit", "/revisions"] },
  { list: "/monitoring", href: /^\/monitoring\/[0-9a-f-]{36}$/, suffixes: ["/edit"] },
  { list: "/monitoring/infra", href: /^\/monitoring\/infra\/[0-9a-f-]{36}$/, suffixes: ["/edit"] },
  { list: "/monitoring/network-cisco", href: /^\/monitoring\/network-cisco\/switches\/[0-9a-f-]{36}$/ },
  { list: "/ipam", href: /^\/ipam\/[0-9a-f-]{36}$/ },
  { list: "/cabinets", href: /^\/cabinets\/[0-9a-f-]{36}$/, suffixes: ["/print"] },
  { list: "/checklists", href: /^\/checklists\/[0-9a-f-]{36}$/ },
  { list: "/admin/checklists/services", href: /^\/admin\/checklists\/services\/[0-9a-f-]{36}$/ },
  { list: "/admin/settings", href: /^\/admin\/settings\/[a-z_-]+$/ },
];

interface Found {
  where: string;
  scheme: string;
  size: string;
  rule: string;
  impact: string;
  help: string;
  nodes: Array<{ target: string; html: string; summary: string }>;
}

const found: Found[] = [];
const scanned: string[] = [];

async function scan(page: Page, where: string, scheme: string, size: string) {
  // A colour caught half way through a transition is not what a person sees at rest.
  await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important;animation:none!important}" });
  await page.mouse.move(0, 0);
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
  scanned.push(`${size} ${scheme} ${where}`);
  for (const v of result.violations) {
    if (v.id in ACCEPTED) continue;
    found.push({
      where, scheme, size, rule: v.id, impact: v.impact ?? "", help: v.help,
      nodes: v.nodes.slice(0, 4).map((n) => ({ target: n.target.join(" "), html: n.html.slice(0, 200), summary: (n.failureSummary ?? "").replace(/\s+/g, " ").slice(0, 260) })),
    });
  }
}

async function visit(page: Page, route: string): Promise<boolean> {
  const res = await page.goto(route, { waitUntil: "domcontentloaded" });
  if (!res || res.status() >= 400) {
    found.push({ where: route, scheme: "-", size: "-", rule: "load", impact: "", help: `HTTP ${res?.status()}`, nodes: [] });
    return false;
  }
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  return true;
}

/** The first detail screens that exist, found by following the links on the list screens. */
async function detailRoutes(page: Page): Promise<string[]> {
  const out: string[] = [];
  for (const d of DETAILS) {
    if (!(await visit(page, d.list))) continue;
    const hrefs = await page.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href") ?? ""));
    const first = [...new Set(hrefs)].filter((h) => d.href.test(h));
    // Settings has one screen per category; the rest are one example each.
    for (const h of d.list === "/admin/settings" ? first : first.slice(0, 1)) {
      out.push(h);
      for (const s of d.suffixes ?? []) out.push(h + s);
    }
  }
  return out;
}

test.afterAll(async () => {
  if (process.env.A11Y_REPORT) {
    mkdirSync("test-results", { recursive: true });
    writeFileSync("test-results/a11y.json", JSON.stringify({ found, scanned }, null, 1));
  }
});

const SIZES = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 800 },
] as const;

for (const size of SIZES) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`axe, ${size.name}, ${scheme}`, () => {
      let context: BrowserContext;
      let page: Page;
      test.beforeAll(async ({ browser }) => {
        context = await browser.newContext({ colorScheme: scheme, viewport: { width: size.width, height: size.height } });
        page = await context.newPage();
        await signInAsTestUser(page);
      });
      test.afterAll(async () => {
        await context.close();
      });

      test("every screen", async () => {
        test.setTimeout(900_000);
        const routes = [...ROUTES, ...(await detailRoutes(page))];
        for (const route of routes) {
          if (await visit(page, route)) await scan(page, route, scheme, size.name);
        }
      });

      test("menus and dialogs", async () => {
        test.setTimeout(120_000);
        await visit(page, "/");
        // The top bar's drop-down menus.
        for (const label of ["IT", "Docs", "Administration"]) {
          const trigger = page.getByRole("button", { name: label, exact: true });
          if (await trigger.count()) {
            await trigger.first().click();
            await expect(page.getByRole("menu")).toBeVisible();
            await scan(page, `/ with the ${label} menu open`, scheme, size.name);
            await page.keyboard.press("Escape");
            if (await page.getByRole("menu").count()) await trigger.first().click();
          }
        }
        // The command palette.
        await visit(page, "/");
        await page.locator("html[data-palette-ready]").waitFor({ state: "attached" });
        await page.keyboard.press("Control+k");
        await expect(page.getByRole("dialog", { name: "Command palette" }).getByRole("combobox")).toBeVisible();
        await scan(page, "/ with the command palette open", scheme, size.name);
        await page.keyboard.press("Escape");
      });
    });
  }
}

test.describe("the keyboard", () => {
  let context: BrowserContext;
  let page: Page;
  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext();
    page = await context.newPage();
    await signInAsTestUser(page);
  });
  test.afterAll(async () => {
    await context.close();
  });

  test("the first Tab stop is a skip link that moves focus into the page", async () => {
    // A fresh page load: nothing is focused, so the first Tab goes to the first stop in the page.
    await visit(page, "/tickets");
    await page.keyboard.press("Tab");
    const link = page.getByRole("link", { name: "Skip to content" });
    await expect(link).toBeFocused();
    await expect(link).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page.locator("main").first()).toBeFocused();
    // The next Tab goes into the page, not back to the top bar.
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.querySelector("main")?.contains(document.activeElement))).toBe(true);
  });

  test("the command palette traps focus and gives it back", async () => {
    await visit(page, "/tickets");
    await page.locator("html[data-palette-ready]").waitFor({ state: "attached" });
    const opener = page.getByRole("link", { name: /new ticket/i }).first();
    await opener.focus();
    await page.keyboard.press("Control+k");
    const box = page.getByRole("dialog", { name: "Command palette" }).getByRole("combobox");
    await expect(box).toBeFocused();
    for (let i = 0; i < 6; i++) await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(box).toBeHidden();
    await expect(opener).toBeFocused();
  });

  test("a dialog takes focus, keeps it, closes on Escape and gives it back", async () => {
    await visit(page, "/admin/groups");
    const opener = page.getByRole("button", { name: /^(manage|view) /i }).first();
    await opener.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAccessibleName(/group/i);
    expect(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)).toBe(true);
    // Tab never leaves the dialog, however many times it is pressed.
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  });

  test("a drop-down menu opens from the keyboard and Escape returns to its button", async () => {
    await visit(page, "/");
    const trigger = page.getByRole("button", { name: "IT", exact: true }).first();
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toBeHidden();
    await expect(trigger).toBeFocused();
  });
});

test("no violations anywhere", async () => {
  const summary = found
    .map((f) => `${f.size}/${f.scheme} ${f.where}: ${f.rule} (${f.impact}) ${f.help}\n    ${f.nodes.map((n) => `${n.target} :: ${n.summary}`).join("\n    ")}`)
    .join("\n");
  expect(scanned.length, "the sweep must have scanned something").toBeGreaterThan(100);
  expect(summary).toBe("");
});
