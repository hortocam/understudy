/**
 * Constitution IX — every config key ships with documentation and a runnable example in the same
 * change. This test fails when a key in the contract is not documented in README.md: a main config
 * key must appear by its full dotted path, and every key of a layer file (recipe, fixture, ...) by name.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { configSchema, layerValidator } from "../../src/config/schema.js";

const readme = readFileSync(fileURLToPath(new URL("../../README.md", import.meta.url)), "utf8");
type Schema = { properties?: Record<string, Schema>; additionalProperties?: Schema | boolean; oneOf?: Schema[]; $ref?: string };
const defs = (configSchema as { $defs: Record<string, Schema> }).$defs;

/** Dotted key paths of the main config, following `additionalProperties` maps as `<Name>`. */
function paths(schema: Schema, prefix = ""): string[] {
  const out: string[] = [];
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    out.push(path);
    out.push(...paths(child, path));
  }
  const extra = schema.additionalProperties;
  if (extra && typeof extra === "object") out.push(...paths(extra, `${prefix}.<Name>`.replace(/^\./, "")));
  return out;
}

describe("every contract key is documented (constitution IX)", () => {
  const mainKeys = paths(configSchema as unknown as Schema).filter((k) => !k.includes("$defs"));
  // map-valued keys are documented as `<Name>`/`<field>` rows: normalise our placeholder
  const documentedForm = (path: string): string[] => [path, path.replace(/<Name>\.relations\.<Name>/, "<Name>.relations.<field>")];

  it.each(mainKeys)("`%s` appears in README.md", (path) => {
    const forms = documentedForm(path);
    const found = forms.some((f) => readme.includes(`\`${f}\``) || readme.includes(`${f}:`));
    // a top-level key is documented in the table or shown in a runnable fragment
    const leaf = path.split(".").pop() as string;
    const topLevelShown = !path.includes(".") && (readme.includes(`| \`${path}\``) || readme.includes(`${path}:`) || readme.includes(`# ${path}:`));
    expect(found || topLevelShown || (path.includes(".") && readme.includes(`${leaf}:`) && readme.includes(`\`${path.split(".").slice(0, -1).join(".")}`)), `README must document ${path}`).toBe(true);
  });

  it("every key of the layer-file shapes (fixtures, recipes, behaviour, imports) appears in the README by name", () => {
    const names = new Set<string>();
    const collect = (schema: Schema): void => {
      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        names.add(key);
        collect(child);
      }
      for (const branch of schema.oneOf ?? []) collect(branch);
      if (schema.additionalProperties && typeof schema.additionalProperties === "object") collect(schema.additionalProperties);
    };
    for (const name of ["FixtureFile", "RecipeEntity", "Recipe", "FieldRule", "GeneratorDef", "BehaviorFile", "ImportMapping"]) collect(defs[name] as Schema);
    // behaviour/imports keys are documented in the layers table + the shipped .example files
    const missing = [...names].filter((n) => !readme.includes(n));
    expect(missing).toEqual([]);
  });

  it("the contract itself carries a documented example for each layer-file definition", () => {
    for (const name of ["LookupFile", "EntitiesFile", "Recipe", "BehaviorFile", "ImportMapping", "FieldRule", "GeneratorDef"]) {
      expect((defs[name] as { examples?: unknown[] }).examples?.length, name).toBeGreaterThan(0);
    }
  });
});

describe("every example in the contract is valid against its own definition (constitution IX: runnable)", () => {
  const withExamples = Object.entries(defs).filter(([, def]) => Array.isArray((def as { examples?: unknown[] }).examples));

  it.each(withExamples.map(([name]) => name))("every `%s` example validates", (name) => {
    const examples = (defs[name] as { examples: unknown[] }).examples;
    const validate = layerValidator(name as Parameters<typeof layerValidator>[0]);
    for (const example of examples) {
      expect(validate(example), `${name}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });
});

describe("the README's behaviour example is runnable (valid against the contract)", () => {
  it("validates", async () => {
    const { parse } = await import("yaml");
    const match = /<!-- behavior-example -->\n```yaml\n([\s\S]*?)```/.exec(readme);
    expect(match, "README must carry the <!-- behavior-example --> block").not.toBeNull();
    const validate = layerValidator("BehaviorFile");
    const value = parse(match?.[1] ?? "");
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
  });
});
