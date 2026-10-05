import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // The live derivation fetches the real vendor document (opt-in, never CI-blocking, never
    // vendored — licence unresolved): run it with `npm run test:live`.
    exclude: ["tests/live/**", "node_modules/**"],
    reporters: ["default"],
    // Integration tests drive a real mock over HTTP against a real SQLite file;
    // 5s per test is too tight once the CRUD engine lands (slice 1).
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
