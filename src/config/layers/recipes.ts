/**
 * The recipes layer (FR-003): `dynamic/<name>.yaml` — a named, switchable generation recipe.
 *
 * Loading is pure: parse, validate against the contract, parse every JSONata expression (so a
 * typo refuses at load, with every other config error, not on the first record), extract each
 * `expr` rule's sibling-field dependencies, and refuse a dependency cycle. Selection by name
 * lives here too; a recipe the user did not select is still validated, so a typo cannot hide in
 * the dataset you switch to next.
 */
import { join } from "node:path";
import jsonata from "jsonata";
import { ConfigLayerInvalidError, RecipeNotFoundError } from "../../errors.js";
import { listLayerFiles, readLayerFile, validateLayerFile, type LayerFile } from "./files.js";

export type FieldRule = Record<string, unknown>;

export interface PerParent {
  entity: string;
  range: [number, number];
  distribution?: "uniform" | "zipf";
}

export interface RecipeEntity {
  source?: "import";
  count?: number;
  perParent?: PerParent;
  fields?: Record<string, FieldRule>;
  constraints?: string[];
  redraws?: number;
}

export interface LoadedRecipe {
  name: string;
  /** Config-directory-relative file, for messages. */
  file: string;
  /** Absolute directory of the file, against which plugin paths resolve. */
  dir: string;
  seed?: number;
  entities: Record<string, RecipeEntity>;
  generators: Record<string, Record<string, unknown>>;
}

interface AstNode {
  type?: string;
  value?: unknown;
  steps?: AstNode[];
  [key: string]: unknown;
}

/** Parse a JSONata expression, or throw jsonata's own syntax error. */
export function parseExpression(expression: string): AstNode {
  return jsonata(expression).ast() as unknown as AstNode;
}

/** The sibling field names an expression reads: the first step of every path, `$`-helpers excluded. */
export function exprDependencies(expression: string): string[] {
  const names = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const ast = node as AstNode;
    if (ast.type === "path" && Array.isArray(ast.steps)) {
      const first = ast.steps[0];
      if (first?.type === "name" && typeof first.value === "string") names.add(first.value);
      // Step predicates/stages run in the step's own context, not the record's.
      ast.steps.slice(1).forEach((step) => {
        for (const [key, child] of Object.entries(step)) if (key !== "predicate" && key !== "stages") walk(child);
      });
      return;
    }
    for (const child of Object.values(ast)) walk(child);
  };
  walk(parseExpression(expression));
  return [...names].sort();
}

function checkExpressions(file: LayerFile, entities: Record<string, RecipeEntity>): void {
  for (const [name, entity] of Object.entries(entities)) {
    const exprFields = new Map<string, string[]>();
    for (const [field, rule] of Object.entries(entity.fields ?? {})) {
      if (typeof rule.expr !== "string") continue;
      try {
        exprFields.set(field, exprDependencies(rule.expr));
      } catch (error) {
        throw new ConfigLayerInvalidError(
          "recipes",
          file.rel,
          `entities.${name}.fields.${field}.expr`,
          `not a valid JSONata expression: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    (entity.constraints ?? []).forEach((constraint, index) => {
      try {
        parseExpression(constraint);
      } catch (error) {
        throw new ConfigLayerInvalidError(
          "recipes",
          file.rel,
          `entities.${name}.constraints[${index}]`,
          `not a valid JSONata expression: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
    checkExprCycles(file, name, exprFields);
  }
}

/** A cycle among `expr` fields of one collection can never be evaluated: refuse, naming the fields. */
function checkExprCycles(file: LayerFile, entity: string, exprFields: Map<string, string[]>): void {
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (field: string): void => {
    if (state.get(field) === "done") return;
    if (state.get(field) === "visiting") {
      const cycle = [...stack.slice(stack.indexOf(field)), field];
      throw new ConfigLayerInvalidError(
        "recipes",
        file.rel,
        `entities.${entity}.fields.${field}.expr`,
        `expression cycle among fields: ${cycle.join(" -> ")}`,
      );
    }
    state.set(field, "visiting");
    stack.push(field);
    for (const dep of exprFields.get(field) ?? []) if (exprFields.has(dep)) visit(dep);
    stack.pop();
    state.set(field, "done");
  };
  for (const field of [...exprFields.keys()].sort()) visit(field);
}

function checkCounts(file: LayerFile, entities: Record<string, RecipeEntity>): void {
  for (const [name, entity] of Object.entries(entities)) {
    if (entity.source === "import") continue;
    if (entity.count === undefined && entity.perParent === undefined) {
      throw new ConfigLayerInvalidError(
        "recipes",
        file.rel,
        `entities.${name}`,
        'says neither how many records ("count") nor how many per parent ("perParent"); a collection absent from the recipe is simply not generated',
      );
    }
    if (entity.count !== undefined && entity.perParent !== undefined) {
      throw new ConfigLayerInvalidError("recipes", file.rel, `entities.${name}`, 'has both "count" and "perParent"; choose one');
    }
    const range = entity.perParent?.range;
    if (range && range[0] > range[1]) {
      throw new ConfigLayerInvalidError("recipes", file.rel, `entities.${name}.perParent.range`, "the minimum exceeds the maximum");
    }
  }
}

/** Load every recipe under `dir` (name = file stem), validating all of them. */
export function loadRecipes(dir: string, baseDir: string): Map<string, LoadedRecipe> {
  const recipes = new Map<string, LoadedRecipe>();
  const origin = new Map<string, string>();
  for (const file of listLayerFiles(dir, baseDir)) {
    const earlier = origin.get(file.stem);
    if (earlier !== undefined) {
      throw new ConfigLayerInvalidError(
        "recipes",
        file.rel,
        "(file name)",
        `recipe "${file.stem}" is defined twice: ${earlier} and ${file.rel}`,
      );
    }
    origin.set(file.stem, file.rel);
    const value = readLayerFile(file);
    validateLayerFile("Recipe", "recipes", file, value ?? {});
    const body = (value ?? {}) as Record<string, unknown>;
    const entities = (body.entities ?? {}) as Record<string, RecipeEntity>;
    checkCounts(file, entities);
    checkExpressions(file, entities);
    const recipe: LoadedRecipe = {
      name: file.stem,
      file: file.rel,
      dir: join(file.path, ".."),
      entities,
      generators: (body.generators ?? {}) as Record<string, Record<string, unknown>>,
    };
    if (typeof body.seed === "number") recipe.seed = body.seed;
    recipes.set(file.stem, recipe);
  }
  return recipes;
}

/** Select a recipe by name, or refuse naming it and listing what exists. */
export function selectRecipe(recipes: Map<string, LoadedRecipe>, name: string): LoadedRecipe {
  const recipe = recipes.get(name);
  if (!recipe) throw new RecipeNotFoundError(name, [...recipes.keys()]);
  return recipe;
}
