import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    reporters: ["default"],
    // Integration tests drive a real mock over HTTP against a real SQLite file;
    // 5s per test is too tight once the CRUD engine lands (slice 1).
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
