import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      // Most of the shared package's rules are tested from here. The api loads its built dist, whose source maps point the
      // coverage back at packages/shared/src, so allow files outside this package and count them against their sources.
      allowExternal: true,
      include: ["**/apps/api/src/**", "**/packages/shared/src/**", "**/packages/shared/dist/**"],
      exclude: ["**/*.d.ts", "**/node_modules/**", "**/apps/api/test/**"],
    },
  },
});
