/**
 * FR-013 / US2.5 — a stated invariant is enforced by redraw up to a budget, then the run fails
 * loudly, naming the rule, and nothing invalid is ever stored.
 */
import { describe, expect, it } from "vitest";
import { ExprEvaluator } from "../../src/data/generators/expr.js";
import { generateRecord } from "../../src/data/record.js";
import { InvariantViolatedError } from "../../src/errors.js";
import { createStream } from "../../src/data/seed.js";
import { makeEnv, REF_DATE, resourceOf } from "../helpers/env.js";

const resource = resourceOf("Inventory", { cost: { type: "number" }, price: { type: "number" } }, ["cost", "price"]);
const fields = {
  cost: { faker: "number.int", min: 20, max: 400 },
  price: { expr: "cost * $uniform(0.5, 2.5)" },
};

/** An evaluator that counts how many times each expression was evaluated. */
class CountingEvaluator extends ExprEvaluator {
  readonly counts = new Map<string, number>();
  override async evaluate(expression: string, record: Record<string, unknown>): Promise<unknown> {
    this.counts.set(expression, (this.counts.get(expression) ?? 0) + 1);
    return super.evaluate(expression, record);
  }
}

describe("invariants (FR-013)", () => {
  it("`price >= cost` holds on 1 000 records, met by REDRAW (the unconstrained draw violates it about a third of the time)", async () => {
    const env = await makeEnv({ collection: "Inventory" });
    let redraws = 0;
    for (let i = 1; i <= 1000; i += 1) {
      const out = await generateRecord({ resource, fields, constraints: ["price >= cost"] }, env, i);
      expect(out.record.price as number).toBeGreaterThanOrEqual(out.record.cost as number);
      redraws += out.redraws;
    }
    expect(redraws).toBeGreaterThan(0); // the invariant was actually enforced, not vacuously true
  });

  it("an impossible invariant fails after exactly `redraws` redraws with InvariantViolatedError naming collection and rule; nothing is returned", async () => {
    const stream = createStream(42, "Inventory", REF_DATE);
    const counting = new CountingEvaluator(stream.rng, REF_DATE);
    const env = { ...(await makeEnv({ collection: "Inventory" })), stream, expr: counting };
    const error = await generateRecord({ resource, fields, constraints: ["price > 1000000"], redraws: 7 }, env, 1).catch((e) => e as Error);
    expect(error).toBeInstanceOf(InvariantViolatedError);
    expect((error as Error).message).toContain("Inventory");
    expect((error as Error).message).toContain("price > 1000000");
    expect((error as Error).message).toContain("7");
    expect(counting.counts.get("price > 1000000")).toBe(8); // the first attempt plus 7 redraws
  });

  it("the budget is configurable per collection, and the default is 50", async () => {
    const stream = createStream(1, "Inventory", REF_DATE);
    const counting = new CountingEvaluator(stream.rng, REF_DATE);
    const env = { ...(await makeEnv({ collection: "Inventory" })), stream, expr: counting };
    await generateRecord({ resource, fields, constraints: ["false"] }, env, 1).catch(() => undefined);
    expect(counting.counts.get("false")).toBe(51);
  });

  it("redraws never touch supplied (level 2) fields: a supplied value that violates the rule cannot be redrawn away", async () => {
    const env = await makeEnv({ collection: "Inventory" });
    const error = await generateRecord(
      { resource, fields: { price: { expr: "cost * 2" } }, constraints: ["cost > 1000"], redraws: 3 },
      env,
      1,
      { cost: 5 },
    ).catch((e) => e as Error);
    expect(error).toBeInstanceOf(InvariantViolatedError);
  });

  it("a satisfiable rule met on the first attempt costs no redraw", async () => {
    const env = await makeEnv({ collection: "Inventory" });
    const out = await generateRecord({ resource, fields, constraints: ["cost >= 0"] }, env, 1);
    expect(out.redraws).toBe(0);
  });
});
