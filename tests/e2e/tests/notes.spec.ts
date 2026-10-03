import { test, expect, type Page } from "@playwright/test";

// Dedicated test user — must match apps/api/src/scripts/reset-test-user.ts.
// The bootstrap admin user is never signed in as by these tests.
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
  // Try the post-change-password value first, since auth.spec.ts runs first
  // and changes the password as part of its flow.
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
    throw new Error(`signInAsTestUser: ended at unexpected URL ${page.url()}`);
  }
}

// Every note this suite creates is prefixed with this marker so the cleanup
// only touches its own rows — manual notes on a dev DB survive a test run.
const E2E_PREFIX = "[e2e]";

async function wipeAllNotes(page: Page) {
  for (const archived of ["false", "true"]) {
    const ids = (await page.evaluate(
      async ({ a, prefix }) => {
        const r = await fetch(`/api/notes?archived=${a}`, { credentials: "same-origin" });
        const list = (await r.json()) as Array<{ id: string; title: string }>;
        return list.filter((n) => n.title.startsWith(prefix)).map((n) => n.id);
      },
      { a: archived, prefix: E2E_PREFIX },
    )) as string[];
    for (const id of ids) {
      await page.evaluate(
        (i) => fetch(`/api/notes/${i}`, { method: "DELETE", credentials: "same-origin" }),
        id,
      );
    }
  }
}

test.describe("Phase 1.1 — Notes", () => {
  test.beforeEach(async ({ page }) => {
    await signInAsTestUser(page);
    // Sign-in lands somewhere; navigate to /notes so /api/notes is same-origin
    // (fetch from a /signin page won't carry the session cookie correctly in
    // some browsers' first navigation).
    await page.goto("/notes");
    await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible();
    await wipeAllNotes(page);
    await page.reload();
  });

  test("Notes link from dashboard navigates to /notes", async ({ page }) => {
    await page.goto("/");
    // Notes now lives inside the Docs dropdown. Open the menu then click in.
    await page.getByRole("button", { name: /^docs$/i }).click();
    await page.getByRole("menuitem", { name: /^notes$/i }).click();
    await page.waitForURL(/\/notes$/);
    await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible();
  });

  test("create, edit, archive, and delete a note", async ({ page }) => {
    const TITLE = "[e2e] note";
    // React renders the `value` attribute on the title input's first render,
    // so this CSS-attribute locator scopes the assertions to *just* our
    // [e2e]-prefixed note even if the test user happens to have other notes.
    const e2eTitle = page.locator(`input[aria-label="Note title"][value="${TITLE}"]`);

    // Sanity: wipe should have cleared any prior [e2e] notes.
    await expect(e2eTitle).toHaveCount(0);

    // create
    await page.getByRole("button", { name: /add note/i }).click();
    const titleField = page.getByLabel("Note title").first();
    await expect(titleField).toBeVisible();
    await titleField.fill(TITLE);
    await titleField.blur();
    const bodyField = page.getByLabel("Note body").first();
    await bodyField.fill("written by playwright");
    await bodyField.blur();

    // reload should persist
    await page.reload();
    await expect(e2eTitle).toHaveCount(1);
    const card = page.locator("article", { has: e2eTitle });
    await expect(card.getByLabel("Note body")).toHaveValue("written by playwright");

    // archive
    await card.getByRole("button", { name: "Archive" }).click();
    await expect(e2eTitle).toHaveCount(0);

    // toggle archived view, see the note again
    await page.getByRole("button", { name: "Active" }).click();
    await expect(page.getByRole("button", { name: "Showing archived" })).toBeVisible();
    await expect(e2eTitle).toHaveCount(1);

    // delete from archived view
    page.once("dialog", (d) => d.accept());
    await page.locator("article", { has: e2eTitle }).getByRole("button", { name: "Delete" }).click();
    await expect(e2eTitle).toHaveCount(0);
  });

  test("attach an image to a note: preview appears, then delete removes it", async ({ page }) => {
    await page.goto("/notes");
    await page.getByRole("button", { name: /add note/i }).click();
    await page.getByLabel("Note title").first().fill("[e2e] with attachment");
    await page.getByLabel("Note title").first().blur();

    // 67-byte PNG (1x1 transparent pixel).
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    );

    // Find the hidden file input and feed it bytes.
    const input = page.locator('input[type="file"]').first();
    await input.setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: png });

    // After upload the preview image appears in the card.
    const preview = page.locator('img[alt="pixel.png"]');
    await expect(preview).toBeVisible({ timeout: 15_000 });

    // Hover to reveal the × button, then accept the confirm dialog.
    await preview.hover();
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Remove attachment" }).click();
    await expect(preview).toBeHidden();
  });
});
