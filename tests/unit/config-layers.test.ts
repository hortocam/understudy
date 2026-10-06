import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsDefault from "ajv-formats";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { configSchema } from "../../src/config/schema.js";
import * as examples from "../fixtures/layers/docs03-examples.js";

const addFormats = addFormatsDefault as unknown as (ajv: unknown) => void;
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(configSchema, "config");

function check(def: string, value: unknown): { ok: boolean; errors: string } {
  const validate = ajv.getSchema(`config#/$defs/${def}`);
  if (!validate) return { ok: false, errors: `no such $def: ${def}` };
  const ok = validate(value) as boolean;
  return { ok, errors: JSON.stringify(validate.errors ?? []) };
}

const CASES: Array<[string, string]> = [
  ["LookupFile", examples.lookupFile],
  ["EntitiesFile", examples.entitiesFile],
  ["Recipe", examples.recipeFile],
  ["BehaviorFile", examples.webhooksFile],
  ["BehaviorFile", examples.actionsFile],
  ["BehaviorFile", examples.simulationsFile],
  ["ImportMapping", examples.mappingFile],
];

describe("the contract's layer-file definitions (FR-001, constitution IX)", () => {
  it.each(CASES)("every docs/03 worked example validates against #/$defs/%s", (def, text) => {
    const result = check(def, parse(text));
    expect(result.errors).toBe("[]");
    expect(result.ok).toBe(true);
  });

  it("refuses an unknown key, a wrong type, two rule kinds, a bad distribution, a bad range arity", () => {
    const recipe = parse(examples.recipeFile) as Record<string, unknown>;
    expect(check("Recipe", recipe).ok, "the unmutated example is valid, so a refusal below is real").toBe(true);
    const mutate = (path: string, value: unknown): unknown => {
      const copy = structuredClone(recipe);
      const parts = path.split(".");
      let node = copy as Record<string, unknown>;
      for (const part of parts.slice(0, -1)) node = node[part] as Record<string, unknown>;
      node[parts[parts.length - 1] as string] = value;
      return copy;
    };
    const bad: Array<[string, unknown]> = [
      ["unknown recipe key", mutate("bogus", 1)],
      ["unknown entity key", mutate("entities.Inventory.bogus", 1)],
      ["wrong type (seed)", mutate("seed", "42")],
      ["two rule kinds", mutate("entities.Inventory.fields.row", { faker: "string.alpha", generator: "x" })],
      ["distribution not in enum", mutate("entities.Inventory.perParent.distribution", "gaussian")],
      ["range arity", mutate("entities.Inventory.perParent.range", [10])],
      ["no rule kind", mutate("entities.Inventory.fields.row", { length: 1 })],
    ];
    for (const [label, value] of bad) {
      expect(check("Recipe", value).ok, label).toBe(false);
    }
    expect(check("LookupFile", { entity: "X", rows: [{ id: 1 }], bogus: true }).ok).toBe(false);
    expect(check("BehaviorFile", { targets: { pos: { url: "x", bogus: 1 } } }).ok).toBe(false);
    expect(check("BehaviorFile", { subscriptions: [{ name: "n", on: "A.created" }] }).ok).toBe(false); // target required
  });
});
