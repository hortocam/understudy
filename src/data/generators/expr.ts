/**
 * `expr`: a JSONata calculation over the record's own sibling fields (FR-011, research §2), and the
 * boolean invariants of FR-013.
 *
 * The seeded helpers — `$uniform(min, max)`, `$int(min, max)`, `$choice(array)` — are registered
 * with TYPE SIGNATURES, so a wrong-typed argument raises instead of silently producing a bad value,
 * and every draw is taken from the collection's own stream, so an expression is exactly as
 * reproducible as a generator (and a calc over a sibling collection's draws cannot shift it).
 * `$now()` and `$millis()` are overridden to the clock seam's instant: JSONata's built-ins would
 * read the wall clock and break byte-identical exports (FR-019).
 */
import jsonata from "jsonata";
import type { Rng } from "../seed.js";

type Compiled = ReturnType<typeof jsonata>;

export class ExprEvaluator {
  readonly #cache = new Map<string, Compiled>();
  readonly #rng: Rng;
  readonly #instant: Date;

  constructor(rng: Rng, instant: Date) {
    this.#rng = rng;
    this.#instant = instant;
  }

  #compile(expression: string): Compiled {
    const hit = this.#cache.get(expression);
    if (hit) return hit;
    const compiled = jsonata(expression);
    const rng = this.#rng;
    const instant = this.#instant;
    compiled.registerFunction("uniform", (min: number, max: number) => rng.float(min, max), "<nn:n>");
    compiled.registerFunction("int", (min: number, max: number) => rng.int(min, max), "<nn:n>");
    compiled.registerFunction("choice", (items: unknown[]) => rng.pick(items), "<a:x>");
    compiled.registerFunction("now", () => instant.toISOString(), "<:s>");
    compiled.registerFunction("millis", () => instant.getTime(), "<:n>");
    this.#cache.set(expression, compiled);
    return compiled;
  }

  /**
   * Evaluate against `record`. An expression that yields nothing — it reads a field the record
   * does not have — is an error, never an `undefined` value that would silently drop the field.
   */
  async evaluate(expression: string, record: Record<string, unknown>): Promise<unknown> {
    const value = await this.#compile(expression).evaluate(record);
    if (value === undefined) {
      throw new Error(`the expression "${expression}" produced no value (does it read a field the record does not have?)`);
    }
    return value;
  }
}
