/**
 * The generator registry (FR-011, FR-012): built-in named generators and custom ones — declared
 * under a recipe's `generators:` or loaded from a plugin file — share ONE namespace and are used
 * identically (`generator: <name>`).
 *
 * A plugin receives only the collection's seeded stream (plus read-only facts about the field), not
 * a faker instance, the clock or the store, so it cannot break determinism by construction.
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { LoadedRecipe } from "../../config/layers/recipes.js";
import { UnknownGeneratorError } from "../../errors.js";
import { drawChoice } from "./choice.js";
import { runFaker } from "./faker.js";
import { BUILTIN_GENERATOR_NAMES } from "./names.js";
import type { GenContext, GeneratorFn } from "./types.js";

const DAY_MS = 24 * 3600 * 1000;

/** The built-in named generators: plausible values by category (names, codes, amounts, dates, quantities). */
const BUILTINS: Record<string, GeneratorFn> = {
  name: ({ faker }) => faker.person.fullName(),
  firstName: ({ faker }) => faker.person.firstName(),
  lastName: ({ faker }) => faker.person.lastName(),
  email: ({ faker }) => faker.internet.email(),
  phone: ({ faker }) => faker.phone.number(),
  company: ({ faker }) => faker.company.name(),
  city: ({ faker }) => faker.location.city(),
  address: ({ faker }) => faker.location.streetAddress(),
  code: ({ faker }) => faker.string.alphanumeric({ length: 6, casing: "upper" }),
  amount: ({ faker }) => Number(faker.finance.amount({ min: 1, max: 1000, dec: 2 })),
  date: ({ faker, instant }) =>
    faker.date.between({ from: new Date(instant.getTime() - 365 * DAY_MS), to: new Date(instant.getTime() + 365 * DAY_MS) }).toISOString(),
  pastDate: ({ faker }) => faker.date.past().toISOString(),
  futureDate: ({ faker }) => faker.date.future().toISOString(),
  quantity: ({ faker }) => faker.number.int({ min: 1, max: 10 }),
  uuid: ({ faker }) => faker.string.uuid(),
  word: ({ faker }) => faker.lorem.word(),
  sentence: ({ faker }) => faker.lorem.sentence(),
};

export class GeneratorRegistry {
  readonly #fns: Map<string, GeneratorFn>;

  constructor(fns: Map<string, GeneratorFn>) {
    this.#fns = fns;
  }

  has(name: string): boolean {
    return this.#fns.has(name);
  }

  run(name: string, ctx: GenContext): unknown {
    const fn = this.#fns.get(name);
    if (!fn) throw new UnknownGeneratorError("(generator registry)", `${ctx.collection}.${ctx.field}`, name);
    return fn(ctx);
  }
}

async function loadPlugin(recipe: LoadedRecipe, name: string, path: string): Promise<GeneratorFn> {
  const full = resolve(recipe.dir, path);
  let loaded: { default?: unknown };
  try {
    loaded = (await import(pathToFileURL(full).href)) as { default?: unknown };
  } catch (error) {
    throw new Error(`${recipe.file}: generators.${name}.plugin — cannot load ${full}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof loaded.default !== "function") {
    throw new Error(`${recipe.file}: generators.${name}.plugin — ${full} must default-export a function (ctx) => value`);
  }
  const plugin = loaded.default as (ctx: unknown) => unknown;
  // Only the stream and read-only facts: no faker, no clock, no store.
  return (ctx) => plugin({ collection: ctx.collection, field: ctx.field, schema: ctx.schema, record: ctx.record, rng: ctx.rng });
}

/** Build the namespace for one recipe: the built-ins plus the recipe's custom generators. */
export async function createRegistry(recipe?: LoadedRecipe): Promise<GeneratorRegistry> {
  const fns = new Map<string, GeneratorFn>();
  for (const name of BUILTIN_GENERATOR_NAMES) {
    const fn = BUILTINS[name];
    if (!fn) throw new Error(`built-in generator "${name}" is declared but not implemented`);
    fns.set(name, fn);
  }
  for (const [name, def] of Object.entries(recipe?.generators ?? {})) {
    if (fns.has(name)) {
      throw new Error(`${recipe?.file ?? "recipe"}: generators.${name} collides with the built-in generator of the same name; generators share one namespace`);
    }
    if (Array.isArray(def.choice)) {
      const weights = Array.isArray(def.weights) ? (def.weights as number[]) : undefined;
      fns.set(name, (ctx) => drawChoice(def.choice as unknown[], weights, ctx.rng));
    } else if (typeof def.faker === "string") {
      fns.set(name, (ctx) => runFaker(ctx.faker, def.faker as string, def));
    } else if (typeof def.seq === "string") {
      fns.set(name, (ctx) => ctx.sequences.next(ctx.collection, def.seq as string, def.start as number | undefined, def.step as number | undefined));
    } else if (typeof def.plugin === "string" && recipe) {
      fns.set(name, await loadPlugin(recipe, name, def.plugin));
    } else {
      throw new Error(`${recipe?.file ?? "recipe"}: generators.${name} defines no choice, faker, seq or plugin`);
    }
  }
  return new GeneratorRegistry(fns);
}
