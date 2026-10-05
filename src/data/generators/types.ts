/** Shapes shared by the generators (FR-011, FR-012). */
import type { Faker } from "@faker-js/faker";
import type { Rng } from "../seed.js";
import type { Schema } from "../../spec/schema-util.js";

/** Everything a generator may use for ONE field of ONE record. */
export interface GenContext {
  collection: string;
  field: string;
  /** The property's own schema in the document. */
  schema: Schema;
  /** The sibling fields drawn so far (read-only by convention). */
  record: Readonly<Record<string, unknown>>;
  rng: Rng;
  faker: Faker;
  /** The clock seam's instant for this run. */
  instant: Date;
  sequences: SequenceLike;
}

export interface SequenceLike {
  next(collection: string, name: string, start?: number, step?: number): number;
}

export type GeneratorFn = (ctx: GenContext) => unknown;

/** The existing records of another collection, for `ref:` rules and decided links. */
export interface ReferencePool {
  /** The value of `field` on every existing record of `collection`, in identity order. */
  values(collection: string, field: string): unknown[];
}
