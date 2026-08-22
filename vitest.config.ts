import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [".github/actions/**/*.test.ts"],
    // These suites shell out to real git, so a run is dominated by process spawn, not assertions.
    testTimeout: 20000,
  },
});
