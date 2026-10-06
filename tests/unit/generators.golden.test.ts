/**
 * Generator goldens (constitution VII family 3). One table per built-in generator rule with a fixed
 * seed: the structural guarantees are asserted directly (membership, weights, monotonicity), and
 * the exact value vector is a checked-in regression golden so reproducibility cannot drift.
 */
import { describe, expect, it } from "vitest";
import { drawChoice } from "../../src/data/generators/choice.js";
import { runFaker } from "../../src/data/generators/faker.js";
import { drawLookup } from "../../src/data/generators/lookup.js";
import { drawReference } from "../../src/data/generators/reference.js";
import { SequenceState } from "../../src/data/generators/sequence.js";
import type { ReferencePool } from "../../src/data/generators/types.js";
import type { FixtureRows } from "../../src/data/fixtures.js";
import { createStream } from "../../src/data/seed.js";
import { expectGolden } from "../helpers/golden.js";

const REF = new Date("2026-01-01T00:00:00.000Z");
const stream = () => createStream(42, "Inventory", REF);
const take = <T>(n: number, fn: () => T): T[] => Array.from({ length: n }, fn);

const statuses: FixtureRows = {
  idField: "id",
  rows: [
    { row: { id: 1, code: "available" }, file: "f" },
    { row: { id: 2, code: "held" }, file: "f" },
    { row: { id: 3, code: "sold" }, file: "f" },
    { row: { id: 4, code: "cancelled" }, file: "f" },
  ],
};

describe("choice", () => {
  const set = ["100", "101", "102", "200", "201", "FLOOR", "GA"];
  it("every drawn value is a member of the set", () => {
    const { rng } = stream();
    const values = take(500, () => drawChoice(set, undefined, rng));
    expect(values.every((v) => set.includes(v as string))).toBe(true);
    expect(new Set(values).size).toBe(set.length); // uniform: every member eventually appears
  });

  it("weights are honoured (a zero weight is never chosen)", () => {
    const { rng } = stream();
    const values = take(2000, () => drawChoice(["a", "b", "c"], [0.8, 0.2, 0], rng));
    expect(values).not.toContain("c");
    expect(values.filter((v) => v === "a").length / 2000).toBeGreaterThan(0.75);
  });

  it("matches the golden vector", () => {
    const { rng } = stream();
    expectGolden("generators-choice", take(20, () => drawChoice(set, undefined, rng)));
  });
});

describe("seq", () => {
  it("is monotonic, named, and independent per collection", () => {
    const seq = new SequenceState();
    expect(take(4, () => seq.next("Inventory", "n", 10, 5))).toEqual([10, 15, 20, 25]);
    expect(seq.next("Inventory", "other")).toBe(1); // a different name is a different sequence
    expect(seq.next("Event", "n", 10, 5)).toBe(10); // a different collection is independent
    expect(seq.next("Inventory", "n", 10, 5)).toBe(30); // and the first carried on
  });
});

describe("lookup", () => {
  it("a draw yields a row identity that exists in the table (uniform)", () => {
    const { rng } = stream();
    const ids = take(300, () => drawLookup(statuses, { lookup: "InventoryStatus" }, rng));
    expect(ids.every((id) => [1, 2, 3, 4].includes(id as number))).toBe(true);
    expect(new Set(ids)).toEqual(new Set([1, 2, 3, 4]));
  });

  it("weighted draws follow 0.8 / 0.1 / 0.1 within a stated tolerance over 5 000 draws; an unlisted row has weight 0", () => {
    const { rng } = stream();
    const rule = { lookup: "InventoryStatus", weights: { available: 0.8, held: 0.1, sold: 0.1 } };
    const ids = take(5000, () => drawLookup(statuses, rule, rng)) as number[];
    const share = (id: number): number => ids.filter((v) => v === id).length / 5000;
    expect(Math.abs(share(1) - 0.8)).toBeLessThan(0.03);
    expect(Math.abs(share(2) - 0.1)).toBeLessThan(0.03);
    expect(Math.abs(share(3) - 0.1)).toBeLessThan(0.03);
    expect(share(4)).toBe(0);
  });

  it("`by` keys the weights on another column, and `value` yields another column", () => {
    const { rng } = stream();
    const rule = { lookup: "InventoryStatus", by: "id", weights: { "3": 1 }, value: "code" };
    expect(take(20, () => drawLookup(statuses, rule, rng))).toEqual(Array(20).fill("sold"));
  });

  it("weights that exclude every row refuse rather than draw nothing", () => {
    const { rng } = stream();
    expect(() => drawLookup(statuses, { lookup: "S", weights: { nope: 1 } }, rng)).toThrow(/weight/i);
  });

  it("matches the golden vector", () => {
    const { rng } = stream();
    const rule = { lookup: "InventoryStatus", weights: { available: 0.8, held: 0.1, sold: 0.1 } };
    expectGolden("generators-lookup", take(20, () => drawLookup(statuses, rule, rng)));
  });
});

describe("ref", () => {
  const pool: ReferencePool = { values: (collection, field) => (collection === "Event" && field === "id" ? [11, 12, 13] : []) };
  it("draws an existing identity of another collection", () => {
    const { rng } = stream();
    const values = take(100, () => drawReference(pool, "Event.id", rng));
    expect(values.every((v) => [11, 12, 13].includes(v as number))).toBe(true);
  });
  it("a collection with no records refuses, naming it (never invents a parent)", () => {
    const { rng } = stream();
    expect(() => drawReference(pool, "Ghost.id", rng)).toThrow(/Ghost/);
  });
  it("matches the golden vector", () => {
    const { rng } = stream();
    expectGolden("generators-ref", take(20, () => drawReference(pool, "Event.id", rng)));
  });
});

describe("faker", () => {
  it("runs a faker path with its options, reproducibly", () => {
    const a = stream().faker;
    const b = stream().faker;
    const run = (f: typeof a): unknown[] => take(10, () => runFaker(f, "string.alpha", { length: 1, casing: "upper" }));
    expect(run(a)).toEqual(run(b));
    expect(run(stream().faker).every((v) => /^[A-Z]$/.test(v as string))).toBe(true);
  });
  it("honours integer bounds", () => {
    const f = stream().faker;
    const values = take(200, () => runFaker(f, "number.int", { min: 2, max: 8 })) as number[];
    expect(Math.min(...values)).toBeGreaterThanOrEqual(2);
    expect(Math.max(...values)).toBeLessThanOrEqual(8);
  });
  it("an unknown path refuses, naming it", () => {
    expect(() => runFaker(stream().faker, "no.such", {})).toThrow(/no\.such/);
  });
  it("matches the golden vector", () => {
    const f = stream().faker;
    expectGolden("generators-faker", {
      alpha: take(10, () => runFaker(f, "string.alpha", { length: 1, casing: "upper" })),
      amount: take(10, () => runFaker(f, "finance.amount", { min: 20, max: 400, dec: 2 })),
      int: take(10, () => runFaker(f, "number.int", { min: 2, max: 8 })),
    });
  });
});
