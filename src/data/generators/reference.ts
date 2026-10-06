/** A reference to an existing record of another collection (FR-011, FR-009, SC-004). */
import { GenerationRefusedError } from "../../errors.js";
import type { Rng } from "../seed.js";
import type { ReferencePool } from "./types.js";

/** Draw the `field` of an existing `Collection.field`. Never invents a parent that does not exist. */
export function drawReference(pool: ReferencePool, ref: string, rng: Rng): unknown {
  const [collection, field] = ref.split(".") as [string, string];
  const values = pool.values(collection, field);
  if (values.length === 0) {
    throw new GenerationRefusedError(
      collection,
      field,
      `${collection} has no records to reference (generate it first, declare fixtures for it, or make the field optional)`,
    );
  }
  return rng.pick(values);
}
