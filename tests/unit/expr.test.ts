import { describe, expect, it } from "vitest";
import { ExprEvaluator } from "../../src/data/generators/expr.js";
import { createStream } from "../../src/data/seed.js";

const REF = new Date("2026-01-01T00:00:00.000Z");

describe("expr — a JSONata calculation over the record's own sibling fields (FR-011, US2.4)", () => {
  it("evaluates over the siblings and equals cost × the seeded draw (recomputed from the stream)", async () => {
    const a = createStream(42, "Inventory", REF);
    const evaluator = new ExprEvaluator(a.rng, REF);
    const price = (await evaluator.evaluate("cost * $uniform(1.1, 2.5)", { cost: 100 })) as number;

    const b = createStream(42, "Inventory", REF);
    const expected = 100 * b.rng.float(1.1, 2.5);
    expect(price).toBeCloseTo(expected, 10);
    expect(price).toBeGreaterThanOrEqual(110);
    expect(price).toBeLessThan(250);
  });

  it("seeded helpers draw from the COLLECTION'S stream: re-running is identical, a sibling collection's draws do not shift it", async () => {
    const run = async (siblingDrawsFirst: boolean): Promise<number[]> => {
      const own = createStream(7, "Inventory", REF);
      const other = createStream(7, "Event", REF);
      if (siblingDrawsFirst) for (let i = 0; i < 50; i += 1) other.rng.next();
      const evaluator = new ExprEvaluator(own.rng, REF);
      const out: number[] = [];
      for (let i = 0; i < 5; i += 1) out.push((await evaluator.evaluate("$uniform(0, 1000)", {})) as number);
      return out;
    };
    expect(await run(false)).toEqual(await run(false));
    expect(await run(true)).toEqual(await run(false));
  });

  it("$choice and $int are seeded too", async () => {
    const evaluator = new ExprEvaluator(createStream(1, "X", REF).rng, REF);
    const picks = new Set<unknown>();
    for (let i = 0; i < 100; i += 1) picks.add(await evaluator.evaluate('$choice(["a","b","c"])', {}));
    expect(picks).toEqual(new Set(["a", "b", "c"]));
    const n = (await evaluator.evaluate("$int(3, 5)", {})) as number;
    expect([3, 4, 5]).toContain(n);
  });

  it("time is governed by the clock seam: $now() is the run's instant, never the wall clock", async () => {
    const evaluator = new ExprEvaluator(createStream(1, "X", REF).rng, REF);
    expect(await evaluator.evaluate("$now()", {})).toBe("2026-01-01T00:00:00.000Z");
    expect(await evaluator.evaluate("$millis()", {})).toBe(REF.getTime());
  });

  it("a wrong-typed operand fails loudly (JSONata's own error, not a silent value)", async () => {
    const evaluator = new ExprEvaluator(createStream(1, "X", REF).rng, REF);
    await expect(evaluator.evaluate("cost * 2", { cost: "x" })).rejects.toThrow(/number/);
    await expect(evaluator.evaluate('$uniform("a", 2)', {})).rejects.toThrow();
  });

  it("an expression that yields nothing (a missing sibling) is an error, never an undefined value", async () => {
    const evaluator = new ExprEvaluator(createStream(1, "X", REF).rng, REF);
    await expect(evaluator.evaluate("missing + 1", {})).rejects.toThrow(/no value/i);
  });

  it("an invariant-style boolean evaluates over the record", async () => {
    const evaluator = new ExprEvaluator(createStream(1, "X", REF).rng, REF);
    expect(await evaluator.evaluate("price >= cost", { price: 10, cost: 5 })).toBe(true);
    expect(await evaluator.evaluate("price >= cost", { price: 1, cost: 5 })).toBe(false);
  });
});
