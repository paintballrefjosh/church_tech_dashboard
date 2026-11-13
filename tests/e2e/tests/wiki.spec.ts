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

/** Type each entry as its own line into the focused editor. */
async function typeLines(page: Page, lines: string[]) {
  for (const [i, line] of lines.entries()) {
    if (i > 0) await page.keyboard.press("Enter");
    await page.keyboard.type(line);
  }
}

async function wipeAllWikiPages(page: Page) {
  await page.goto("/wiki");
  const ids = (await page.evaluate(async (prefix) => {
    // Searching (q) is the only list that includes archived pages; browsing leaves them out, and a test that died after
    // archiving one would otherwise leave it here for good.
    const r = await fetch(`/api/wiki?q=${encodeURIComponent(prefix)}&limit=200`, { credentials: "same-origin" });
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
    // The body is a Tiptap rich-text editor: type like a person so its
    // markdown shortcuts ("# ", "**…**", "- ") build a heading, bold and a list.
    await page.getByRole("textbox", { name: "Body" }).click();
    await typeLines(page, ["# Welcome", "This is **markdown**.", "- one", "two"]);
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
    await page.getByRole("textbox", { name: "Body" }).click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Backspace");
    await typeLines(page, ["Now with a third bullet.", "- one", "two", "three"]);
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

  test("reading and editing are separate lists, and the editor never scrolls sideways", async ({ page }) => {
    // A long group name is what used to push the Add button out of the card and make a scrollbar.
    const longName = `${RESTRICTED_GROUP_NAME}-${"long-group-name-".repeat(4)}`;
    await page.goto("/wiki");
    const groupId = (await page.evaluate(async (name) => {
      const r = await fetch("/api/v1/groups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ name }),
      });
      return ((await r.json()) as { id: string }).id;
    }, longName)) as string;
    try {
      await page.goto("/wiki/new");
      await page.getByLabel("Title").fill(`${E2E_PREFIX} read and edit`);
      const sidewaysScroll = () =>
        page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      const readBox = page.getByRole("group", { name: "Who can read this page" });
      const editBox = page.getByRole("group", { name: "Who can edit this page" });

      // Public by default: everyone reads, and a group can still be given edit rights.
      await expect(readBox.getByRole("radio", { name: /^Everyone/ })).toBeChecked();
      await editBox.getByLabel("Add a group that can edit this page").selectOption(groupId);
      await editBox.getByRole("button", { name: "Add", exact: true }).click();
      await expect(editBox.getByRole("button", { name: /^Remove .* from editors$/ })).toHaveCount(1);

      // Restricted: the group is now a reader too (editing implies reading), the Add buttons stay on screen.
      await readBox.getByRole("radio", { name: /^Restricted to groups/ }).check();
      await expect(readBox.getByText("can also edit")).toBeVisible();
      for (const box of [readBox, editBox]) {
        const add = box.getByRole("button", { name: "Add", exact: true });
        const card = await box.boundingBox();
        const button = await add.boundingBox();
        expect(button!.x + button!.width).toBeLessThanOrEqual(card!.x + card!.width);
      }
      expect(await sidewaysScroll()).toBeLessThanOrEqual(0);

      // Taking the edit right away leaves the group reading.
      await editBox.getByRole("button", { name: /^Remove .* from editors$/ }).click();
      await expect(readBox.getByText("can also edit")).toHaveCount(0);
      await expect(readBox.getByRole("button", { name: /^Remove .* from readers/ })).toHaveCount(1);

      // Give it edit rights again, save, and the page says who reads and who edits.
      await editBox.getByLabel("Add a group that can edit this page").selectOption(groupId);
      await editBox.getByRole("button", { name: "Add", exact: true }).click();
      await Promise.all([
        page.waitForURL(/\/wiki\/[0-9a-f-]+$/, { timeout: 15_000 }),
        page.getByRole("button", { name: "Create page" }).click(),
      ]);
      await expect(page.getByText("Restricted").first()).toBeVisible();
      await expect(page.getByText(/^Read: /)).toBeVisible();
      await expect(page.getByText(/^Edit: /)).toBeVisible();
    } finally {
      await page.evaluate(
        (i) => fetch(`/api/v1/groups/${i}`, { method: "DELETE", credentials: "same-origin" }),
        groupId,
      );
    }
  });

  test("the edit page's Access card summarises who reads and edits, and a dialog changes it", async ({ page }) => {
    const groupName = `${RESTRICTED_GROUP_NAME}-${"long-group-name-".repeat(4)}`;
    await page.goto("/wiki");
    const groupId = (await page.evaluate(async (name) => {
      const r = await fetch("/api/v1/groups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ name }),
      });
      return ((await r.json()) as { id: string }).id;
    }, groupName)) as string;
    let pageId = "";
    try {
      pageId = (await page.evaluate(async () => {
        const r = await fetch("/api/wiki", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ title: "[e2e] access dialog", body: "x" }),
        });
        return ((await r.json()) as { id: string }).id;
      })) as string;
      await page.goto(`/wiki/${pageId}/edit`);
      const read = page.getByTestId("access-read-summary");
      const edit = page.getByTestId("access-edit-summary");
      await expect(read).toHaveText("Everyone");
      await expect(edit).toHaveText("The owner and Wiki admins");

      // Cancel throws the draft away.
      await page.getByRole("button", { name: "Edit access" }).click();
      const dialog = page.getByRole("dialog", { name: "Who can read and edit this page" });
      await dialog.getByLabel("Add a group that can edit this page").selectOption(groupId);
      await dialog.getByRole("button", { name: "Add", exact: true }).click();
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(edit).toHaveText("The owner and Wiki admins");

      // Apply: everyone still reads, and the group edits.
      await page.getByRole("button", { name: "Edit access" }).click();
      await dialog.getByLabel("Add a group that can edit this page").selectOption(groupId);
      await dialog.getByRole("button", { name: "Add", exact: true }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      await dialog.getByRole("button", { name: "Apply" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(read).toHaveText("Everyone");
      await expect(edit).toContainText(groupName);

      // A restricted page with no groups cannot be applied.
      await page.getByRole("button", { name: "Edit access" }).click();
      await dialog.getByRole("radio", { name: /^Restricted to groups/ }).check();
      await dialog.getByRole("button", { name: /^Remove .* from readers/ }).click();
      await expect(dialog.getByRole("button", { name: "Apply" })).toBeDisabled();
      await dialog.getByRole("button", { name: "Cancel" }).click();

      // Saving keeps it, and the page says who edits.
      await Promise.all([
        page.waitForURL(/\/wiki\/[0-9a-f-]+$/, { timeout: 15_000 }),
        page.getByRole("button", { name: /save changes/i }).click(),
      ]);
      await expect(page.getByText(/^Edit: /)).toContainText(groupName);
      await expect(page.getByText("Public").first()).toBeVisible();
    } finally {
      // The wipe at the start of each test would only catch this page on the NEXT test, and this one is last.
      if (pageId) {
        await page.evaluate(
          (i) => fetch(`/api/wiki/${i}`, { method: "DELETE", credentials: "same-origin" }),
          pageId,
        );
      }
      await page.evaluate(
        (i) => fetch(`/api/v1/groups/${i}`, { method: "DELETE", credentials: "same-origin" }),
        groupId,
      );
    }
  });
  test("an archived page leaves the menu, comes last in a search with a flag, and can be restored", async ({ page }) => {
    const word = `e2earch${Date.now().toString(36)}`;
    const make = (title: string) =>
      page.evaluate(
        async ([t, w]) => {
          const r = await fetch("/api/wiki", {
            method: "POST",
            headers: { "content-type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ title: t, body: w }),
          });
          return ((await r.json()) as { id: string }).id;
        },
        [title, word],
      );
    const ids: string[] = [];
    try {
      await page.goto("/wiki");
      ids.push(await make(`[e2e] ${word} alpha`));
      const target = await make(`[e2e] ${word} beta`);
      ids.push(target);
      // Made last, so newest: a search lists gamma, then beta, then alpha, until beta is archived.
      ids.push(await make(`[e2e] ${word} gamma`));

      // Archive from the page itself.
      await page.goto(`/wiki/${target}`);
      await expect(page.getByTestId("archived-banner")).toHaveCount(0);
      await page.getByTestId("wiki-archive").click();
      const banner = page.getByTestId("archived-banner");
      await expect(banner).toContainText("This page is archived");
      await expect(page.getByTestId("wiki-archive")).toHaveCount(0);
      // Still readable by address, with its text.
      await expect(page.getByRole("heading", { name: `[e2e] ${word} beta` })).toBeVisible();

      // The menu leaves it out; the other two are there.
      await page.goto("/wiki");
      await expect(page.getByRole("link", { name: `[e2e] ${word} beta` })).toHaveCount(0);
      await expect(page.getByRole("link", { name: `[e2e] ${word} alpha` }).first()).toBeVisible();

      // Searching the wiki lists it last, flagged.
      await page.goto(`/wiki?q=${word}`);
      // The results list only: the menu beside it holds the same titles.
      const rows = page.getByTestId("wiki-list").getByRole("listitem");
      await expect(rows).toHaveCount(3);
      await expect(rows.last()).toContainText(`beta`);
      await expect(rows.last().getByTestId("archived-pill")).toBeVisible();
      await expect(page.getByTestId("archived-pill")).toHaveCount(1);

      // Restore from the banner.
      await page.goto(`/wiki/${target}`);
      await page.getByTestId("wiki-unarchive").click();
      await expect(page.getByTestId("archived-banner")).toHaveCount(0);
      await expect(page.getByTestId("wiki-archive")).toBeVisible();
      await page.goto("/wiki");
      await expect(page.getByRole("link", { name: `[e2e] ${word} beta` }).first()).toBeVisible();
    } finally {
      for (const id of ids) {
        await page.evaluate(
          (i) => fetch(`/api/wiki/${i}`, { method: "DELETE", credentials: "same-origin" }),
          id,
        );
      }
    }
  });
});
