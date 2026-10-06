/**
 * Named sequences (FR-011). Monotonic, and independent per (collection, name): a sequence in one
 * collection never advances because another collection drew, so adding a collection cannot shift
 * an existing one's values (SC-007). State lives for one generation run, so a re-run from a wiped
 * store restarts every sequence at its start — the same data, byte for byte.
 */
import type { SequenceLike } from "./types.js";

export class SequenceState implements SequenceLike {
  readonly #counters = new Map<string, number>();

  next(collection: string, name: string, start = 1, step = 1): number {
    const key = `${collection}\u0000${name}`;
    const index = this.#counters.get(key) ?? 0;
    this.#counters.set(key, index + 1);
    return start + index * step;
  }
}
