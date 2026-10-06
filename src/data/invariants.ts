/**
 * Invariants (FR-013): a stated condition over a generated record, as a JSONata boolean
 * (`price >= cost`). The redraw loop lives in `record.ts`; this is the check. A condition that
 * does not evaluate to exactly `true` counts as violated — `undefined` (a missing field) must never
 * read as "satisfied".
 */
import type { ExprEvaluator } from "./generators/expr.js";

/** The first constraint the record violates, or undefined when it satisfies them all. */
export async function firstViolated(
  constraints: readonly string[],
  record: Record<string, unknown>,
  expr: ExprEvaluator,
): Promise<string | undefined> {
  for (const constraint of constraints) {
    let verdict: unknown;
    try {
      verdict = await expr.evaluate(constraint, record);
    } catch {
      verdict = false; // an invariant that cannot be evaluated is not satisfied
    }
    if (verdict !== true) return constraint;
  }
  return undefined;
}
