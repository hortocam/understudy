/**
 * A draw from a lookup table, uniformly or by weights (FR-011, US2.3).
 *
 * Weights are keyed by the row's `by` column (default `code`, falling back to the row's
 * identity), and a row the weights do not name has weight 0. The draw yields the row's identity
 * (or its `value` column), so the stored value references a real row of the table.
 */
import { GenerationRefusedError } from "../../errors.js";
import type { FixtureRows } from "../fixtures.js";
import type { Rng } from "../seed.js";

export interface LookupRule {
  lookup: string;
  weights?: Record<string, number>;
  by?: string;
  value?: string;
}

export function drawLookup(table: FixtureRows, rule: LookupRule, rng: Rng): unknown {
  const rows = table.rows.map((entry) => entry.row);
  if (rows.length === 0) throw new GenerationRefusedError(rule.lookup, "(lookup)", `the lookup table ${rule.lookup} has no rows`);
  let chosen: Record<string, unknown>;
  if (rule.weights) {
    const by = rule.by ?? "code";
    const weights = rows.map((row) => rule.weights?.[String(row[by] ?? row[table.idField])] ?? 0);
    if (!weights.some((w) => w > 0)) {
      throw new GenerationRefusedError(
        rule.lookup,
        "(lookup)",
        `no row of ${rule.lookup} has a positive weight (weights are keyed by "${by}": ${Object.keys(rule.weights).join(", ")})`,
      );
    }
    chosen = rng.weighted(rows, weights);
  } else {
    chosen = rng.pick(rows);
  }
  return chosen[rule.value ?? table.idField];
}
