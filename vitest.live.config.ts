import { defineConfig } from "vitest/config";

// Tests that call the real Lichess API. Not part of CI: they depend on the network.
export default defineConfig({
  test: {
    include: ["test/live/*.test.ts"],
    testTimeout: 30_000,
    fileParallelism: false,
  },
});
