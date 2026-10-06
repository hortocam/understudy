/** A value from an explicit set, uniformly or by weights (FR-011). */
import type { Rng } from "../seed.js";

export function drawChoice(values: readonly unknown[], weights: readonly number[] | undefined, rng: Rng): unknown {
  if (weights && weights.length === values.length) return rng.weighted(values, weights);
  return rng.pick(values);
}
