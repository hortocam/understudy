/**
 * Per-collection seed derivation (FR-016, research §1, §3).
 *
 * Each collection draws from its OWN stream, derived from `(globalSeed, collectionName)` — never
 * from an index into one shared stream. A shared stream would satisfy "same seed, same output"
 * (SC-002) and still fail SC-007: adding a collection would shift every later draw. Deriving by
 * NAME makes both consequences, not aspirations.
 *
 * The stream is faker's 53-bit Mersenne Twister seeded with the derived integer, so the whole draw
 * sequence is reproducible on every machine; the collection's Faker instance and every
 * hand-written draw (`Rng`) consume the SAME stream, in generation order.
 */
import { createHash } from "node:crypto";
import { Faker, base, en, generateMersenne53Randomizer } from "@faker-js/faker";

/** A source of reproducible numbers. `next()` is in [0, 1). */
export interface Rng {
  next(): number;
  /** An integer in [min, max], inclusive. */
  int(min: number, max: number): number;
  /** A float in [min, max). */
  float(min: number, max: number): number;
  bool(probability?: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** An item chosen by relative weights (a zero weight is never chosen). */
  weighted<T>(items: readonly T[], weights: readonly number[]): T;
}

export interface Stream {
  /** The derived seed, reported so "collection X, seed 0x…" is a sentence an integrator can act on. */
  seed: number;
  rng: Rng;
  /** A faker instance drawing from this stream, its relative dates anchored to the run's clock instant. */
  faker: Faker;
}

/** `hash(globalSeed, name)` as an unsigned 32-bit integer. */
export function deriveSeed(globalSeed: number, name: string): number {
  const digest = createHash("sha256").update(`${globalSeed}\u0000${name}`).digest();
  return digest.readUInt32BE(0);
}

function wrap(next: () => number): Rng {
  const rng: Rng = {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    float: (min, max) => min + next() * (max - min),
    bool: (probability = 0.5) => next() < probability,
    pick: (items) => items[Math.floor(next() * items.length)] as never,
    weighted: (items, weights) => {
      const total = weights.reduce((sum, w) => sum + w, 0);
      if (!(total > 0)) return items[0] as never;
      let point = next() * total;
      for (let i = 0; i < items.length; i += 1) {
        point -= weights[i] as number;
        if (point < 0 && (weights[i] as number) > 0) return items[i] as never;
      }
      return items[items.length - 1] as never;
    },
  };
  return rng;
}

/** The stream for one collection. `refDate` is the clock seam's instant (research §1 trap). */
export function createStream(globalSeed: number, collection: string, refDate: Date): Stream {
  const seed = deriveSeed(globalSeed, collection);
  const randomizer = generateMersenne53Randomizer(seed);
  const faker = new Faker({ locale: [en, base], randomizer });
  faker.setDefaultRefDate(refDate);
  return { seed, rng: wrap(() => randomizer.next()), faker };
}
