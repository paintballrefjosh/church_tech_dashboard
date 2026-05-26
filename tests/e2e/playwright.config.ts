import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  // One worker = test files run sequentially. The suite shares a single admin
  // user in a single DB, so anything that mutates auth state must not race.
  // Files run in alphabetical order: auth.spec.ts -> notes.spec.ts.
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.BASE ?? "http://localhost:8100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  timeout: 30_000,
  expect: { timeout: 7_000 },
});
