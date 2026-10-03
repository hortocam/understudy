import { describe, expect, it } from "vitest";

// Harness self-test. It exists so CI exercises the real toolchain (vitest + tsc +
// eslint) from the first commit. Slice-1 tests replace it as the CRUD engine lands.
describe("toolchain", () => {
  it("runs on the pinned major version of Node", () => {
    expect(Number(process.versions.node.split(".")[0])).toBeGreaterThanOrEqual(22);
  });

  it("resolves the package as an ES module", () => {
    expect(import.meta.url).toMatch(/^file:/);
  });
});
