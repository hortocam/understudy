/**
 * The generation run (FR-009, FR-015, FR-016, FR-021): ONE data-driven pass over the plan.
 *
 * For each collection the recipe names, in foreign-key order (parents first): derive the
 * collection's own stream from `(seed, name)`, allocate identities from its reserved range, draw
 * each record by the precedence chain, enforce the invariants, gate on the document's schema, and
 * attach to real parents. There is no per-collection or per-field code — every difference between
 * collections is data in the document, the configuration and the seed (SC-001).
 *
 * The whole run is ATOMIC: every record of every collection is built in memory (references are
 * served from the rows of this run plus what the store already holds), and only then written in a
 * single transaction together with each identity-range advance. A run that fails — an invariant
 * that cannot hold, a schema that cannot be satisfied, a parent that does not exist — stores
 * nothing, so a failed start never leaves a half-populated store (principle V, narrow form).
 *
 * Determinism (principle III): the same seed, configuration, fixtures and document produce the same
 * records — identity and values — because collections draw from independent streams (SC-007),
 * parents are enumerated in identity order, ties break by name, and the clock is read once.
 */
import type { LoadedRecipe, PerParent } from "../config/layers/recipes.js";
import type { Clock } from "../clock.js";
import { GenerationMarkerMismatchError, GenerationRefusedError } from "../errors.js";
import { propertiesOf, requiredOf } from "../spec/schema-util.js";
import { typedIdentityValue } from "../spec/identity.js";
import type { Resource } from "../spec/types.js";
import type { NewRecord, Origin, Store } from "../store/index.js";
import type { FixtureRows } from "./fixtures.js";
import { ExprEvaluator } from "./generators/expr.js";
import { createRegistry } from "./generators/registry.js";
import { SequenceState } from "./generators/sequence.js";
import type { ReferencePool } from "./generators/types.js";
import { IdentityAllocator, type IdentityPlan } from "./identity.js";
import type { GenerationPlan } from "./plan.js";
import { isFallback, type DrawEnv, type Provenance } from "./precedence.js";
import { generateRecord } from "./record.js";
import { createStream, type Rng } from "./seed.js";

export interface GenerationSummary {
  recipe: string;
  seed: number;
  /** False when the store already held this recipe+seed+configuration and nothing was generated (D7). */
  regenerated: boolean;
  /** Records this run created, by collection then origin. */
  created: Record<string, Partial<Record<Origin, number>>>;
  /** Totals in the store after the run, by collection then origin (FR-004). */
  counts: Record<string, Partial<Record<Origin, number>>>;
  /** For each collection and field: how many values each precedence level supplied. */
  provenance: Record<string, Record<string, Record<string, number>>>;
  /** Fields chosen by a heuristic or a type default — the report says so (US7.4). */
  fallbacks: Array<{ collection: string; field: string; rule: string; level: number; count: number }>;
  redraws: number;
  notes: string[];
  instant?: string;
}

export interface GenerateInput {
  store: Store;
  resources: Resource[];
  plan: GenerationPlan;
  recipe: LoadedRecipe;
  seed: number;
  clock: Clock;
  /** Every fixture table by entity (stored or lookup-only), for `lookup:` rules. */
  tables: Map<string, FixtureRows>;
  identityPlans: Map<string, IdentityPlan>;
  /** A digest of everything besides recipe name and seed that determines the data (D7). */
  fingerprint: string;
}

/** Per-parent counts: uniform over the range, or zipf (mass concentrated toward the minimum). */
function countDrawer(spec: PerParent, rng: Rng): () => number {
  const [lo, hi] = spec.range;
  if (spec.distribution === "zipf") {
    const values = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
    const weights = values.map((_, i) => 1 / (i + 1));
    return () => rng.weighted(values, weights);
  }
  return () => rng.int(lo, hi);
}

/** Existing records of a collection: what the store holds plus what this run has built so far. */
class RunPool implements ReferencePool {
  readonly #cache = new Map<string, unknown[]>();
  readonly #inRun = new Map<string, NewRecord[]>();
  readonly #store: Store;
  readonly #resources: Map<string, Resource>;

  constructor(store: Store, resources: Map<string, Resource>) {
    this.#store = store;
    this.#resources = resources;
  }

  add(collection: string, rows: NewRecord[]): void {
    this.#inRun.set(collection, rows);
    for (const key of this.#cache.keys()) if (key.startsWith(`${collection}\u0000`)) this.#cache.delete(key);
  }

  values(collection: string, field: string): unknown[] {
    const key = `${collection}\u0000${field}`;
    const hit = this.#cache.get(key);
    if (hit) return hit;
    const resource = this.#resources.get(collection);
    if (!resource) return [];
    const run = this.#inRun.get(collection) ?? [];
    let out: unknown[];
    if (field === resource.idField) {
      out = [...this.#store.listIdentities(collection), ...run.map((r) => r.identity)].map((id) => typedIdentityValue(resource, id));
    } else {
      const pick = (data: unknown): unknown => (data as Record<string, unknown>)[field];
      out = [...this.#store.list(collection).map((r) => pick(r.data)), ...run.map((r) => pick(r.data))].filter((v) => v !== undefined && v !== null);
    }
    this.#cache.set(key, out);
    return out;
  }
}

const sumGenerated = (counts: Record<string, Partial<Record<Origin, number>>>): number =>
  Object.values(counts).reduce((n, c) => n + (c.generated ?? 0), 0);

export async function generate(input: GenerateInput): Promise<GenerationSummary> {
  const { store, plan, recipe, seed } = input;
  const resources = new Map(input.resources.map((r) => [r.name, r]));
  const base: GenerationSummary = {
    recipe: recipe.name,
    seed,
    regenerated: false,
    created: {},
    counts: {},
    provenance: {},
    fallbacks: [],
    redraws: 0,
    notes: [],
  };

  // D7 — generation on a non-empty store: generate when no generated rows exist; do nothing (and
  // say so) when the marker matches; refuse, naming the mismatch, when it differs.
  const existing = store.countByOrigin();
  if (sumGenerated(existing) > 0) {
    const stored = { recipe: store.getMeta("gen_recipe"), seed: store.getMeta("gen_seed"), config: store.getMeta("gen_config") };
    if (stored.recipe === recipe.name && stored.seed === String(seed) && stored.config === input.fingerprint) {
      return { ...base, counts: existing };
    }
    if (stored.recipe !== recipe.name) throw new GenerationMarkerMismatchError("recipe", stored.recipe ?? "(unknown)", recipe.name);
    if (stored.seed !== String(seed)) throw new GenerationMarkerMismatchError("seed", stored.seed ?? "(unknown)", String(seed));
    throw new GenerationMarkerMismatchError("configuration", (stored.config ?? "(unknown)").slice(0, 12), input.fingerprint.slice(0, 12));
  }

  const run = input.clock.startRun();
  const instant = run.now();
  const stamp = instant.toISOString();
  const registry = await createRegistry(recipe);
  const sequences = new SequenceState();
  const pool = new RunPool(store, resources);
  const position = new Map(plan.order.map((name, i) => [name, i]));
  const order = plan.order.filter((name) => plan.counts[name] !== undefined && plan.counts[name]?.kind !== "import");

  for (const [name, count] of Object.entries(plan.counts)) {
    if (count.kind === "import") base.notes.push(`${name}: its records come from an import (slice 3); generation skips it`);
  }

  const written: Array<{ name: string; rows: NewRecord[]; allocator: IdentityAllocator }> = [];
  const tally = new Map<string, number>();
  const rules = new Map<string, { collection: string; field: string; rule: string; level: number; count: number }>();

  for (const name of order) {
    const resource = resources.get(name) as Resource;
    const entity = recipe.entities[name] ?? {};
    const countPlan = plan.counts[name];
    if (!countPlan || countPlan.kind === "import") continue;
    const stream = createStream(seed, name, instant);
    const env: DrawEnv = {
      stream,
      instant,
      registry,
      sequences,
      lookups: input.tables,
      refs: pool,
      expr: new ExprEvaluator(stream.rng, instant),
    };
    const idPlan = input.identityPlans.get(name) as IdentityPlan;
    const allocator = new IdentityAllocator({ store, resource, plan: idPlan, stream });

    // Decided links: resolvable ones draw an existing parent; a link to a collection generated
    // later (a reported cycle) or to one with no records is omitted when optional, refused when required.
    const required = new Set(requiredOf(resource));
    const links: Array<{ field: string; to: string; toField: string }> = [];
    const omit: string[] = [];
    const supplies = countPlan.kind === "perParent" ? countPlan.field : undefined;
    for (const link of plan.links[name] ?? []) {
      if (link.field === supplies) continue;
      const parent = resources.get(link.to);
      if (!parent || entity.fields?.[link.field] !== undefined) continue; // an explicit rule wins; nothing to resolve
      if (propertiesOf(resource)[link.field] === undefined) continue;
      const forward = (position.get(link.to) as number) >= (position.get(name) as number);
      const none = !forward && pool.values(link.to, parent.idField).length === 0;
      if (forward || none) {
        if (required.has(link.field)) {
          throw new GenerationRefusedError(
            name,
            link.field,
            forward
              ? `${link.to} is generated after ${name} in a relationship cycle, so this required link cannot be resolved`
              : `${link.to} has no records to attach to (generate it, declare fixtures for it, or make the field optional)`,
          );
        }
        omit.push(link.field);
        base.notes.push(`${name}.${link.field}: no ${link.to} record to reference${forward ? " yet (cycle)" : ""}; the optional field is omitted`);
      } else {
        links.push({ field: link.field, to: link.to, toField: parent.idField });
      }
    }

    const spec = {
      resource,
      ...(entity.fields ? { fields: entity.fields } : {}),
      ...(entity.constraints ? { constraints: entity.constraints } : {}),
      ...(entity.redraws !== undefined ? { redraws: entity.redraws } : {}),
      links,
      omit,
    };

    // The work list: (supplied values) per record to build.
    const work: Array<Record<string, unknown>> = [];
    if (countPlan.kind === "absolute") {
      for (let i = 0; i < countPlan.n; i += 1) work.push({});
    } else {
      const parentResource = resources.get(countPlan.parent) as Resource;
      const parents = pool.values(countPlan.parent, parentResource.idField);
      if (parents.length === 0) {
        base.notes.push(`${name}: perParent ${countPlan.parent}, but ${countPlan.parent} has no records (generate it, or declare fixtures for it); 0 ${name} generated`);
      }
      const draw = countDrawer({ entity: countPlan.parent, range: countPlan.range, distribution: countPlan.distribution as "uniform" | "zipf" }, stream.rng);
      for (const parentValue of parents) {
        const n = draw();
        for (let i = 0; i < n; i += 1) work.push({ [countPlan.field]: parentValue });
      }
    }

    const rows: NewRecord[] = [];
    for (const supplied of work) {
      const identity = allocator.next();
      const made = await generateRecord(spec, env, typedIdentityValue(resource, identity), supplied);
      base.redraws += made.redraws;
      rows.push({ resource: name, identity, data: made.record, origin: "generated", createdAt: stamp, updatedAt: stamp });
      for (const [field, provenance] of Object.entries(made.provenance) as Array<[string, Provenance]>) {
        const key = `${name}\u0000${field}\u0000${provenance.level}`;
        tally.set(key, (tally.get(key) ?? 0) + 1);
        if (isFallback(provenance)) {
          const ruleKey = `${key}\u0000${provenance.rule}`;
          const entry = rules.get(ruleKey) ?? { collection: name, field, rule: provenance.rule, level: provenance.level, count: 0 };
          entry.count += 1;
          rules.set(ruleKey, entry);
        }
      }
    }
    pool.add(name, rows);
    written.push({ name, rows, allocator });
  }

  // One transaction for the whole run: every record, every range advance, and the marker.
  store.transaction(() => {
    for (const { rows, allocator } of written) {
      store.insertMany(rows);
      allocator.commit();
    }
    store.setMeta("gen_recipe", recipe.name);
    store.setMeta("gen_seed", String(seed));
    store.setMeta("gen_config", input.fingerprint);
    store.setMeta("recipe", recipe.name);
  });

  for (const { name, rows } of written) base.created[name] = { generated: rows.length };
  for (const [key, count] of tally) {
    const [collection, field, level] = key.split("\u0000") as [string, string, string];
    const byField = (base.provenance[collection] ??= {});
    (byField[field] ??= {})[level] = count;
  }
  base.fallbacks = [...rules.values()].sort((a, b) => `${a.collection}.${a.field}`.localeCompare(`${b.collection}.${b.field}`));
  base.counts = store.countByOrigin();
  base.regenerated = true;
  base.instant = stamp;
  return base;
}
