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

describe("slice-2 dependencies (T001)", () => {
  it("imports faker with a seedable randomizer and jsonata under NodeNext ESM", async () => {
    const { Faker, en, generateMersenne53Randomizer } = await import("@faker-js/faker");
    const first = new Faker({ locale: [en], randomizer: generateMersenne53Randomizer(42) }).number.int({ max: 1e9 });
    const again = new Faker({ locale: [en], randomizer: generateMersenne53Randomizer(42) }).number.int({ max: 1e9 });
    expect(first).toBe(again);
    const { default: jsonata } = await import("jsonata");
    expect(await jsonata("a + 1").evaluate({ a: 41 })).toBe(42);
  });
});
