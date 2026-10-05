/**
 * Reconcile the loaded configuration layers against the derived model and the document
 * (FR-005, constitution I): a configuration may refine the specification and MUST NOT silently
 * contradict it. Every cause is collected in one pass — a developer fixing a project should see
 * the whole list, not one error per restart — and each names `file: key`.
 *
 * Pure: no store, no network. The generator and faker namespaces are injected so `config/` does
 * not depend on `data/`.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Refusal } from "../errors.js";
import { conformanceErrors, valueErrors } from "../spec/conform.js";
import { declaresProperties, propertiesOf } from "../spec/schema-util.js";
import type { DerivedModel, Resource } from "../spec/types.js";
import type { UnderstudyConfig } from "./load.js";
import type { FixtureSet, FixtureTable } from "./layers/fixtures.js";
import { exprDependencies, type LoadedRecipe } from "./layers/recipes.js";

export interface ReconcileInput {
  config: UnderstudyConfig;
  model: Pick<DerivedModel, "resources">;
  fixtures: FixtureSet;
  recipes: LoadedRecipe[];
  /** Built-in generator names (the registry's namespace). */
  knownGenerators: ReadonlySet<string>;
  /** True when `path` names a callable in the faker library. */
  isFakerPath: (path: string) => boolean;
}

const CONFIG_FILE = "understudy.yaml";

/** `'<from>..<to>'`, both non-empty. */
const SPAN = /^(.+)\.\.(.+)$/;

export function reconcile(input: ReconcileInput): Refusal[] {
  const refusals: Refusal[] = [];
  const refuse = (file: string, key: string, cause: string): void => void refusals.push({ file, key, cause });
  const resources = new Map(input.model.resources.map((r) => [r.name, r]));
  const lookupNames = new Set([...input.fixtures.lookups, ...input.fixtures.entities].map((t) => t.entity));

  reconcileEntities(input, resources, refuse);
  reconcileFixtures(input, resources, refuse);
  for (const recipe of input.recipes) reconcileRecipe(input, recipe, resources, lookupNames, refuse);
  return refusals;
}

type Refuse = (file: string, key: string, cause: string) => void;

function fixtureIdentities(input: ReconcileInput, resource: Resource): Array<number | string> {
  const ids: Array<number | string> = [];
  for (const table of [...input.fixtures.lookups, ...input.fixtures.entities]) {
    if (table.entity !== resource.name) continue;
    const idField = table.idField ?? resource.idField;
    for (const row of table.rows) {
      const id = row[idField];
      if (typeof id === "number" || typeof id === "string") ids.push(id);
    }
  }
  return ids;
}

function reconcileEntities(input: ReconcileInput, resources: Map<string, Resource>, refuse: Refuse): void {
  const { config } = input;
  for (const [name, entity] of Object.entries(config.entities)) {
    const base = `entities.${name}`;
    const resource = resources.get(name);
    if (!resource) {
      refuse(CONFIG_FILE, base, `no collection named ${name} is derived from the live operations (known: ${[...resources.keys()].sort().join(", ") || "none"})`);
      continue;
    }
    const properties = propertiesOf(resource);
    const declared = declaresProperties(resource);
    if (entity.idField !== undefined && declared && properties[entity.idField] === undefined) {
      refuse(CONFIG_FILE, `${base}.idField`, `${entity.idField} is not a property of ${name}`);
    }
    for (const [field, relation] of Object.entries(entity.relations ?? {})) {
      const key = `${base}.relations.${field}`;
      if (declared && properties[field] === undefined) refuse(CONFIG_FILE, key, `${field} is not a property of ${name}`);
      const [targetName, targetField] = relation.to.split(".") as [string, string];
      const target = resources.get(targetName);
      if (!target) {
        refuse(CONFIG_FILE, `${key}.to`, `no collection named ${targetName}`);
      } else if (declaresProperties(target) && propertiesOf(target)[targetField] === undefined) {
        refuse(CONFIG_FILE, `${key}.to`, `${targetName} has no property ${targetField}`);
      } else if (targetField !== (config.entities[targetName]?.idField ?? target.idField)) {
        refuse(CONFIG_FILE, `${key}.to`, `${relation.to} is not ${targetName}'s identity (${config.entities[targetName]?.idField ?? target.idField}); a link must target the identity it resolves to`);
      }
    }
    const ids = entity.ids;
    if (ids?.reserved !== undefined) {
      if (resource.idType === "integer" && resource.idPattern === undefined) {
        refuse(CONFIG_FILE, `${base}.ids.reserved`, `${name} has an integer identity; use ids.generatedStart (reserved spans are for uuid and formatted-string identities)`);
      } else if (!SPAN.test(ids.reserved)) {
        refuse(CONFIG_FILE, `${base}.ids.reserved`, `"${ids.reserved}" is not a span written '<from>..<to>'`);
      }
    }
    if (ids?.generatedStart !== undefined && resource.idType === "string") {
      refuse(CONFIG_FILE, `${base}.ids.generatedStart`, `${name} has a string identity; generatedStart is for an integer identity space (use ids.reserved)`);
    }
  }
  // A fixture identity at or above the range start means runtime and generated allocation will
  // eventually collide with a fixture (FR-017, SC-006): refuse at start, naming the collection.
  for (const resource of resources.values()) {
    if (resource.idType !== "integer") continue;
    const entityStart = config.entities[resource.name]?.ids?.generatedStart;
    const start = entityStart ?? config.ids.generatedStart;
    const clash = fixtureIdentities(input, resource).filter((id): id is number => typeof id === "number" && id >= start);
    if (clash.length > 0) {
      refuse(
        CONFIG_FILE,
        entityStart !== undefined ? `entities.${resource.name}.ids.generatedStart` : "ids.generatedStart",
        `fixture identity ${Math.min(...clash)} of ${resource.name} lies at or above the generated range start ${start}; the ranges overlap`,
      );
    }
  }
}

function rowKey(index: number, instancePath: string): string {
  const field = instancePath.split(" ")[0] ?? "";
  const dotted = field.replace(/^\//, "").replace(/\//g, ".");
  return dotted === "" ? `rows[${index}]` : `rows[${index}].${dotted}`;
}

function reconcileFixtures(input: ReconcileInput, resources: Map<string, Resource>, refuse: Refuse): void {
  const lookupFiles = new Set(input.fixtures.lookups.map((t) => t.file));
  const check = (table: FixtureTable): void => {
    const resource = resources.get(table.entity);
    if (!resource) {
      if (!lookupFiles.has(table.file)) {
        refuse(table.file, "entity", `${table.entity} is neither a collection of the live operations nor a lookup table (lookups live under static/lookups/)`);
      }
      return;
    }
    const idField = table.idField ?? resource.idField;
    const properties = propertiesOf(resource);
    if (declaresProperties(resource) && properties[idField] === undefined) {
      refuse(table.file, "idField", `${idField} is not a property of ${table.entity}`);
    }
    table.rows.forEach((row, index) => {
      if (row[idField] === undefined || row[idField] === null) {
        refuse(table.file, `rows[${index}].${idField}`, `the row has no identity field "${idField}" of ${table.entity}`);
      }
      for (const message of conformanceErrors(resource, row)) {
        refuse(table.file, rowKey(index, message), `does not conform to the specification of ${table.entity}: ${message}`);
      }
    });
  };
  for (const table of [...input.fixtures.lookups, ...input.fixtures.entities]) check(table);
}

function reconcileRecipe(
  input: ReconcileInput,
  recipe: LoadedRecipe,
  resources: Map<string, Resource>,
  lookupNames: Set<string>,
  refuse: Refuse,
): void {
  const file = recipe.file;
  for (const [name, generator] of Object.entries(recipe.generators)) {
    if (typeof generator.plugin === "string" && !existsSync(resolve(recipe.dir, generator.plugin))) {
      refuse(file, `generators.${name}.plugin`, `the plugin file ${generator.plugin} does not exist (resolved against ${recipe.dir})`);
    }
    if (input.knownGenerators.has(name)) {
      refuse(file, `generators.${name}`, `collides with the built-in generator of the same name; generators share one namespace`);
    }
  }
  const generatorNames = new Set([...input.knownGenerators, ...Object.keys(recipe.generators)]);

  for (const [name, entity] of Object.entries(recipe.entities)) {
    const base = `entities.${name}`;
    const resource = resources.get(name);
    if (!resource) {
      refuse(file, base, `no collection named ${name} is derived from the live operations`);
      continue;
    }
    if (entity.perParent && !resources.has(entity.perParent.entity)) {
      refuse(file, `${base}.perParent.entity`, `no collection named ${entity.perParent.entity}`);
    }
    const properties = propertiesOf(resource);
    const declared = declaresProperties(resource);
    for (const [field, rule] of Object.entries(entity.fields ?? {})) {
      const key = `${base}.fields.${field}`;
      if (declared && properties[field] === undefined) {
        refuse(file, key, `${name} declares no property ${field}`);
        continue;
      }
      if (typeof rule.lookup === "string" && !lookupNames.has(rule.lookup)) {
        refuse(file, `${key}.lookup`, `no lookup table named ${rule.lookup} (declare it under static/lookups/ or static/entities/)`);
      }
      if (typeof rule.ref === "string") {
        const [target, targetField] = rule.ref.split(".") as [string, string];
        const targetResource = resources.get(target);
        if (!targetResource) refuse(file, `${key}.ref`, `no collection named ${target}`);
        else if (declaresProperties(targetResource) && propertiesOf(targetResource)[targetField] === undefined) {
          refuse(file, `${key}.ref`, `${target} has no property ${targetField}`);
        }
      }
      if (typeof rule.generator === "string" && !generatorNames.has(rule.generator)) {
        refuse(file, `${key}.generator`, `no generator named "${rule.generator}" (built-in or declared under generators:)`);
      }
      if (typeof rule.faker === "string" && !input.isFakerPath(rule.faker)) {
        refuse(file, `${key}.faker`, `"${rule.faker}" is not a faker method`);
      }
      if (typeof rule.expr === "string" && declared) {
        for (const dependency of exprDependencies(rule.expr)) {
          if (properties[dependency] === undefined) {
            refuse(file, `${key}.expr`, `reads ${dependency}, which is not a property of ${name}`);
          }
        }
      }
      if (Array.isArray(rule.choice) && properties[field]) {
        rule.choice.forEach((value, index) => {
          const problems = valueErrors(properties[field] as Record<string, unknown>, value);
          if (problems.length > 0) {
            refuse(file, `${key}.choice[${index}]`, `${JSON.stringify(value)} contradicts the specification of ${name}.${field}: ${problems.join("; ")}`);
          }
        });
      }
    }
  }
}
