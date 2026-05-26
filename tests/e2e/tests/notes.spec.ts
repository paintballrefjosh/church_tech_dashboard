import { test, expect, type Page } from "@playwright/test";

const ADMIN_USERNAME = "admin";
const ADMIN_DEFAULT_PASSWORD = "admin";
const ADMIN_NEW_PASSWORD = "regression-test-pwd-1";

test.describe.configure({ mode: "serial" });

async function signInAsAdmin(page: Page) {
  async function attempt(password: string) {
    await page.goto("/signin");
    await page.getByLabel("Email or username").fill(ADMIN_USERNAME);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/signin") || u.search.includes("error="), {
      timeout: 15_000,
    });
  }
  await attempt(ADMIN_NEW_PASSWORD);
  if (page.url().includes("/signin")) {
    await attempt(ADMIN_DEFAULT_PASSWORD);
    if (page.url().includes("/change-password")) {
      await page.getByLabel("New password").fill(ADMIN_NEW_PASSWORD);
      await page.getByLabel("Confirm password").fill(ADMIN_NEW_PASSWORD);
      await Promise.all([
        page.waitForURL(/\/signin/, { timeout: 15_000 }),
        page.getByRole("button", { name: /save new password/i }).click(),
      ]);
      await attempt(ADMIN_NEW_PASSWORD);
    }
  }
  if (page.url().includes("/signin") || page.url().includes("/change-password")) {
    throw new Error(`signInAsAdmin: ended at unexpected URL ${page.url()}`);
  }
}

async function wipeAllNotes(page: Page) {
  for (const archived of ["false", "true"]) {
    const ids = (await page.evaluate(
      async (a) => {
        const r = await fetch(`/api/notes?archived=${a}`, { credentials: "same-origin" });
        const list = (await r.json()) as Array<{ id: string }>;
        return list.map((n) => n.id);
      },
      archived,
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
    await signInAsAdmin(page);
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
    await page.getByRole("link", { name: "Notes", exact: true }).first().click();
    await page.waitForURL(/\/notes$/);
    await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible();
  });

  test("create, edit, archive, and delete a note", async ({ page }) => {
    // Start clean (beforeEach wiped everything)
    await expect(page.getByText(/no notes yet/i)).toBeVisible();

    // create
    await page.getByRole("button", { name: /add note/i }).click();
    const titleField = page.getByLabel("Note title").first();
    await expect(titleField).toBeVisible();
    await titleField.fill("e2e note");
    await titleField.blur();
    const bodyField = page.getByLabel("Note body").first();
    await bodyField.fill("written by playwright");
    await bodyField.blur();

    // reload should persist
    await page.reload();
    const persistedTitle = page.getByLabel("Note title");
    await expect(persistedTitle).toHaveCount(1);
    await expect(persistedTitle.first()).toHaveValue("e2e note");
    await expect(page.getByLabel("Note body").first()).toHaveValue("written by playwright");

    // archive
    await page.getByRole("button", { name: "Archive" }).click();
    await expect(page.getByText(/no notes yet/i)).toBeVisible();

    // toggle archived view, see the note again
    await page.getByRole("button", { name: "Active" }).click();
    await expect(page.getByRole("button", { name: "Showing archived" })).toBeVisible();
    await expect(page.getByLabel("Note title").first()).toHaveValue("e2e note");

    // delete from archived view
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText(/no archived notes/i)).toBeVisible();
  });
});
