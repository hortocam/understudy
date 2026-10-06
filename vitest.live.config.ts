import { defineConfig } from "vitest/config";

// The opt-in live derivation run (research §0, quickstart scenario 9). Not part of `npm test`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/live/**/*.test.ts"],
    reporters: ["default"],
    testTimeout: 180000,
    hookTimeout: 180000,
  },
});
