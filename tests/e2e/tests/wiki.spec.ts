import { test, expect, type Page } from "@playwright/test";

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
  if (page.url().includes("/signin") || page.url().includes("/change-password")) {
    throw new Error(`signInAsTestUser: ended at ${page.url()}`);
  }
}

// Every page this suite creates is prefixed with this marker so the cleanup
// only touches its own rows — manual wiki pages on a dev DB survive a test run.
const E2E_PREFIX = "[e2e]";
// Restricted-page test needs a group; we always reuse one by this exact name
// rather than creating a new one each run (groups aren't name-unique, so
// blindly POSTing leaks rows).
const RESTRICTED_GROUP_NAME = "wiki-restricted-group";

async function wipeAllWikiPages(page: Page) {
  await page.goto("/wiki");
  const ids = (await page.evaluate(async (prefix) => {
    const r = await fetch("/api/wiki", { credentials: "same-origin" });
    const list = (await r.json()) as Array<{ id: string; title: string }>;
    return list.filter((p) => p.title.startsWith(prefix)).map((p) => p.id);
  }, E2E_PREFIX)) as string[];
  for (const id of ids) {
    await page.evaluate(
      (i) => fetch(`/api/wiki/${i}`, { method: "DELETE", credentials: "same-origin" }),
      id,
    );
  }
}

async function wipeRestrictedGroups(page: Page) {
  // Earlier versions of this suite created a fresh group every run and never
  // cleaned up, leaving dozens of duplicates with the same name. Sweep them
  // before each test so re-running the suite stays idempotent.
  const ids = (await page.evaluate(async (name) => {
    const r = await fetch("/api/v1/groups", { credentials: "same-origin" });
    const list = (await r.json()) as Array<{ id: string; name: string }>;
    return list.filter((g) => g.name === name).map((g) => g.id);
  }, RESTRICTED_GROUP_NAME)) as string[];
  for (const id of ids) {
    await page.evaluate(
      (i) => fetch(`/api/v1/groups/${i}`, { method: "DELETE", credentials: "same-origin" }),
      id,
    );
  }
}

test.describe("Phase 1.4 — Wiki", () => {
  test.beforeEach(async ({ page }) => {
    await signInAsTestUser(page);
    await wipeAllWikiPages(page);
    await wipeRestrictedGroups(page);
  });

  test("Wiki link in the nav goes to /wiki", async ({ page }) => {
    await page.goto("/");
    // Wiki now lives inside the Docs dropdown. Open the menu then click in.
    await page.getByRole("button", { name: /^docs$/i }).click();
    await page.getByRole("menuitem", { name: /^wiki$/i }).click();
    await page.waitForURL(/\/wiki(\?|$)/);
    await expect(page.getByRole("heading", { name: "Wiki" })).toBeVisible();
  });

  test("create a page, view rendered markdown, edit and persist", async ({ page }) => {
    // Create
    await page.goto("/wiki/new");
    await page.getByLabel("Title").fill("[e2e] Getting started");
    await page.getByLabel(/^Body/).fill("# Welcome\n\nThis is **markdown**.\n\n- one\n- two");
    await Promise.all([
      page.waitForURL(/\/wiki\/[0-9a-f-]+$/, { timeout: 15_000 }),
      page.getByRole("button", { name: /create page/i }).click(),
    ]);

    // The view page renders the heading from the markdown
    await expect(page.getByRole("heading", { name: "[e2e] Getting started" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Welcome" })).toBeVisible();
    await expect(page.getByText("This is", { exact: false })).toBeVisible();

    // Edit
    await page.getByRole("link", { name: "Edit", exact: true }).click();
    await page.waitForURL(/\/wiki\/[0-9a-f-]+\/edit$/);
    const body = page.getByLabel(/^Body/);
    await body.fill("# Welcome\n\nNow with a *third* bullet.\n\n- one\n- two\n- three");
    await page.getByLabel(/edit summary/i).fill("add third bullet");
    await Promise.all([
      page.waitForURL(/\/wiki\/[0-9a-f-]+$/, { timeout: 15_000 }),
      page.getByRole("button", { name: /save changes/i }).click(),
    ]);
    await expect(page.getByText("third", { exact: false })).toBeVisible();
  });

  test("creating a restricted page surfaces the 'restricted' badge on view", async ({ page }) => {
    // 1. Make a group (the test user can do this — admin role).
    await page.goto("/wiki");
    const groupId = (await page.evaluate(async () => {
      const r = await fetch("/api/v1/groups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ name: "wiki-restricted-group" }),
      });
      const j = (await r.json()) as { id: string };
      return j.id;
    })) as string;

    // 2. Create the page through the public /api/wiki proxy with visibility=group.
    const pageId = (await page.evaluate(async (gid: string) => {
      const r = await fetch("/api/wiki", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          title: "[e2e] secret handbook",
          body: "members only",
          visibility: "group",
          acl: [{ groupId: gid, canEdit: false }],
        }),
      });
      const p = (await r.json()) as { id: string };
      return p.id;
    }, groupId)) as string;

    // 3. As the owner, the page is visible and clearly marked Restricted.
    await page.goto(`/wiki/${pageId}`);
    await expect(page.getByRole("heading", { name: "[e2e] secret handbook" })).toBeVisible();
    await expect(page.getByText("Restricted").first()).toBeVisible();
  });
});
