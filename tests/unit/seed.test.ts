import { describe, expect, it } from "vitest";
import { createStream, deriveSeed } from "../../src/data/seed.js";

const REF = new Date("2026-01-01T00:00:00.000Z");
const draws = (global: number, name: string, n = 5): number[] => {
  const { rng } = createStream(global, name, REF);
  return Array.from({ length: n }, () => rng.next());
};

describe("per-collection seed derivation (FR-016, SC-002, SC-007; research §1, §3)", () => {
  it("the same (seed, name) gives the same stream, across many constructions", () => {
    const first = draws(42, "Inventory");
    for (let i = 0; i < 10; i += 1) expect(draws(42, "Inventory")).toEqual(first);
  });

  it("a different collection name or global seed gives a different stream", () => {
    expect(draws(42, "Inventory")).not.toEqual(draws(42, "Event"));
    expect(draws(42, "Inventory")).not.toEqual(draws(43, "Inventory"));
  });

  it("derivation is by NAME, not by position: inserting a collection leaves every other stream unchanged (the SC-007 mechanism)", () => {
    const names = ["Venue", "Event", "Inventory"];
    const before = names.map((n) => draws(7, n));
    const withExtra = [...names, "Aardvark"].map((n) => draws(7, n)); // sorts first, appears last
    expect(withExtra.slice(0, 3)).toEqual(before);
    expect(deriveSeed(7, "Venue")).toBe(deriveSeed(7, "Venue"));
  });

  it("is a 32-bit unsigned integer, and the seed is reported with the stream", () => {
    const seed = deriveSeed(42, "Inventory");
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThanOrEqual(0xffffffff);
    expect(createStream(42, "Inventory", REF).seed).toBe(seed);
  });

  it("negative and large global seeds are accepted and distinct", () => {
    expect(deriveSeed(-1, "A")).not.toBe(deriveSeed(1, "A"));
    expect(deriveSeed(2 ** 40, "A")).not.toBe(deriveSeed(0, "A"));
  });

  it("draws are in [0, 1) and cover the range", () => {
    const { rng } = createStream(1, "X", REF);
    const values = Array.from({ length: 2000 }, () => rng.next());
    expect(values.every((v) => v >= 0 && v < 1)).toBe(true);
    expect(Math.min(...values)).toBeLessThan(0.05);
    expect(Math.max(...values)).toBeGreaterThan(0.95);
  });

  it("a checked-in vector pins the stream, so a library upgrade that changes the Mersenne output is caught", () => {
    // (global 42, 'Inventory') -> seed and the first five draws, reviewed and checked in.
    expect(deriveSeed(42, "Inventory")).toMatchInlineSnapshot(`2302014646`);
    expect(draws(42, "Inventory")).toMatchInlineSnapshot(`
      [
        0.19489080691126692,
        0.873893327711808,
        0.2050454969438823,
        0.19423281899960487,
        0.3958009296270293,
      ]
    `);
  });

  it("the faker instance on a stream is reproducible and honours the reference date (research §1 trap)", () => {
    const a = createStream(5, "Event", REF) as unknown as { faker: { date: { recent(): Date }; person: { fullName(): string } } };
    const b = createStream(5, "Event", REF) as unknown as typeof a;
    expect(a.faker.person.fullName()).toBe(b.faker.person.fullName());
    expect(a.faker.date.recent().toISOString()).toBe(b.faker.date.recent().toISOString());
    // relative dates are anchored to REF, not to "today": 'recent' is within a day before REF
    const recent = createStream(5, "Event", REF) as unknown as typeof a;
    const at = recent.faker.date.recent().getTime();
    expect(at).toBeLessThanOrEqual(REF.getTime());
    expect(at).toBeGreaterThan(REF.getTime() - 24 * 3600 * 1000 - 1);
  });
});
