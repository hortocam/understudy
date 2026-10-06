import type { LoadedRecipe } from "../../src/config/layers/recipes.js";
import type { FixtureRows } from "../../src/data/fixtures.js";
import { ExprEvaluator } from "../../src/data/generators/expr.js";
import { createRegistry } from "../../src/data/generators/registry.js";
import { SequenceState } from "../../src/data/generators/sequence.js";
import type { ReferencePool } from "../../src/data/generators/types.js";
import type { DrawEnv } from "../../src/data/precedence.js";
import { createStream } from "../../src/data/seed.js";
import type { Resource } from "../../src/spec/types.js";

export const REF_DATE = new Date("2026-01-01T00:00:00.000Z");

export interface EnvOptions {
  seed?: number;
  collection?: string;
  recipe?: LoadedRecipe;
  lookups?: Map<string, FixtureRows>;
  refs?: ReferencePool;
  expr?: ExprEvaluator;
}

/** A draw environment for one collection, for the value-engine tests. */
export async function makeEnv(options: EnvOptions = {}): Promise<DrawEnv> {
  const stream = createStream(options.seed ?? 42, options.collection ?? "Thing", REF_DATE);
  return {
    stream,
    instant: REF_DATE,
    registry: await createRegistry(options.recipe),
    sequences: new SequenceState(),
    lookups: options.lookups ?? new Map(),
    refs: options.refs ?? { values: () => [] },
    expr: options.expr ?? new ExprEvaluator(stream.rng, REF_DATE),
  };
}

/** A resource with the given property schemas, for tests that need no document. */
export function resourceOf(name: string, properties: Record<string, unknown>, required: string[] = []): Resource {
  return {
    name,
    collectionPath: `/${name}`,
    idField: "id",
    idType: "integer",
    idSpace: "integer",
    pagingStyle: "none-declared",
    filterFields: [],
    sortFields: [],
    listParams: [],
    operations: {},
    nameSource: "schema-title",
    representationSchema: { type: "object", required, properties: { id: { type: "integer" }, ...properties } },
  };
}
