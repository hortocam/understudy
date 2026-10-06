import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { reconcile } from "../../src/config/reconcile.js";
import { parseConfig } from "../../src/config/load.js";
import { loadFixtures } from "../../src/config/layers/fixtures.js";
import { loadRecipes, selectRecipe } from "../../src/config/layers/recipes.js";
import type { Refusal } from "../../src/errors.js";
import { loadSpec } from "../../src/spec/load.js";
import { collectOperations } from "../../src/spec/operations.js";
import { deriveModel } from "../../src/spec/resources.js";
import { fixturePath } from "../helpers/mock.js";
import { makeProject } from "../helpers/project.js";

const BUILTINS = new Set(["name", "email", "code", "amount"]);

async function run(files: Record<string, string>, configExtra = "", recipe?: string): Promise<Refusal[]> {
  const dir = makeProject({
    "understudy.yaml": `spec: ${fixturePath("shop-api.yaml")}\noperations: [GET /venues]\n${configExtra}${recipe ? `recipe: ${recipe}\n` : ""}`,
    ...files,
  });
  const config = parseConfig(`spec: ${fixturePath("shop-api.yaml")}\noperations: [GET /venues]\n${configExtra}${recipe ? `recipe: ${recipe}\n` : ""}`, join(dir, "understudy.yaml"));
  const loaded = await loadSpec(config.spec);
  const model = deriveModel(loaded.document, collectOperations(loaded.document));
  const fixtures = loadFixtures(config.paths.static, config.baseDir);
  const recipes = loadRecipes(config.paths.dynamic, config.baseDir);
  if (recipe) selectRecipe(recipes, recipe);
  return reconcile({
    config,
    model,
    fixtures,
    recipes: [...recipes.values()],
    knownGenerators: BUILTINS,
    isFakerPath: (path: string) => path === "string.alpha" || path === "number.int",
  });
}

const keys = (refusals: Refusal[]): string[] => refusals.map((r) => r.key);

describe("reconcile: config against the document (FR-005, constitution I)", () => {
  it("a consistent project yields no refusals", async () => {
    const refusals = await run(
      {
        "static/entities/venues.yaml": "entity: Venue\nrows:\n  - { id: 1, name: Test Arena, state: MA }\n",
        "dynamic/ci.yaml": "entities:\n  Event:\n    count: 3\n    fields:\n      category: { choice: [music, sport] }\n",
      },
      "entities:\n  Event:\n    relations:\n      venueId: { to: Venue.id }\n",
      "ci",
    );
    expect(refusals).toEqual([]);
  });

  it("entities.<X> naming no collection refuses, naming file and key", async () => {
    const refusals = await run({}, "entities:\n  Ghost: { idField: id }\n");
    expect(keys(refusals)).toContain("entities.Ghost");
    expect(refusals[0]?.file).toBe("understudy.yaml");
  });

  it("a relation on a field that is not a property, a missing target collection or field, a non-identity target", async () => {
    const refusals = await run(
      {},
      [
        "entities:",
        "  Event:",
        "    idField: nope",
        "    relations:",
        "      noSuchField: { to: Venue.id }",
        "      venueId: { to: Ghost.id }",
      ].join("\n") + "\n",
    );
    const k = keys(refusals);
    expect(k).toContain("entities.Event.idField");
    expect(k).toContain("entities.Event.relations.noSuchField");
    expect(k).toContain("entities.Event.relations.venueId.to");
    const more = await run({}, "entities:\n  Event:\n    relations:\n      venueId: { to: Venue.nope }\n  Inventory:\n    relations:\n      eventId: { to: Event.name }\n");
    expect(keys(more)).toEqual(expect.arrayContaining(["entities.Event.relations.venueId.to", "entities.Inventory.relations.eventId.to"]));
  });

  it("ids.generatedStart on a non-integer space and ids.reserved on an integer space contradict the document", async () => {
    const refusals = await run({}, "entities:\n  Venue:\n    ids: { reserved: 'A..B' }\n");
    expect(keys(refusals)).toContain("entities.Venue.ids.reserved");
  });

  it("ids.generatedStart at or below an existing fixture identity refuses", async () => {
    const refusals = await run(
      { "static/entities/venues.yaml": "entity: Venue\nrows:\n  - { id: 150000, name: Big Arena }\n" },
      "entities:\n  Venue:\n    ids: { generatedStart: 100000 }\n",
    );
    expect(keys(refusals)).toContain("entities.Venue.ids.generatedStart");
    expect(refusals.find((r) => r.key === "entities.Venue.ids.generatedStart")?.cause).toMatch(/150000/);
  });

  it("a fixture entity that is neither a collection nor a lookup refuses (D10); a lookup-only table is fine", async () => {
    const refusals = await run({ "static/entities/ghost.yaml": "entity: Ghost\nrows: [{ id: 1 }]\n" });
    expect(refusals[0]?.file).toBe("static/entities/ghost.yaml");
    const ok = await run({ "static/lookups/colors.yaml": "entity: Color\nrows: [{ id: 1, code: red }]\n" });
    expect(ok).toEqual([]);
  });

  it("a fixture row that does not conform to the document's schema refuses (FR-014) — type, enum, format, length", async () => {
    const refusals = await run({
      "static/entities/venues.yaml": [
        "entity: Venue",
        "rows:",
        "  - { id: 1, name: Test Arena, state: ZZ }", // enum
        "  - { id: 2, name: ab }", // minLength 3
        "  - { id: 3, name: 12345 }", // type
        "  - { id: 4 }", // required name
      ].join("\n"),
      "static/entities/events.yaml": "entity: Event\nrows:\n  - { id: 1, name: Gig, venueId: 1, startsAt: not-a-date }\n",
    });
    const k = keys(refusals);
    expect(k).toEqual(expect.arrayContaining(["rows[0].state", "rows[1].name", "rows[2].name", "rows[3]", "rows[0].startsAt"]));
    expect(refusals.every((r) => r.file.startsWith("static/entities/"))).toBe(true);
  });

  it("a recipe naming no collection, a missing perParent parent, an undeclared field, an unknown lookup/ref/generator/faker path refuse", async () => {
    const refusals = await run(
      { "static/lookups/s.yaml": "entity: InventoryStatus\nrows: [{ id: 1, code: available }]\n",
        "dynamic/r.yaml": [
          "entities:",
          "  Ghost: { count: 1 }",
          "  Inventory:",
          "    perParent: { entity: Nowhere, range: [1, 2] }",
          "    fields:",
          "      bogusField: { choice: [1] }",
          "      statusId: { lookup: NoSuchTable }",
          "      eventId: { ref: Event.nope }",
          "      section: { generator: sectionCod }",
          "      row: { faker: no.such.path }",
          "      quantity: { expr: \"missing + 1\" }",
        ].join("\n") },
      "",
      "r",
    );
    const k = keys(refusals);
    expect(k).toEqual(
      expect.arrayContaining([
        "entities.Ghost",
        "entities.Inventory.perParent.entity",
        "entities.Inventory.fields.bogusField",
        "entities.Inventory.fields.statusId.lookup",
        "entities.Inventory.fields.eventId.ref",
        "entities.Inventory.fields.section.generator",
        "entities.Inventory.fields.row.faker",
        "entities.Inventory.fields.quantity.expr",
      ]),
    );
    expect(refusals.every((r) => r.file === "dynamic/r.yaml")).toBe(true);
  });

  it("a choice value the document's schema rejects contradicts the specification", async () => {
    const refusals = await run(
      { "dynamic/r.yaml": "entities:\n  Event:\n    count: 1\n    fields:\n      category: { choice: [music, opera] }\n" },
      "",
      "r",
    );
    expect(keys(refusals)).toContain("entities.Event.fields.category.choice[1]");
  });

  it("reports EVERY problem in one pass, not just the first", async () => {
    const refusals = await run(
      { "dynamic/r.yaml": "entities:\n  Ghost: { count: 1 }\n  Phantom: { count: 1 }\n" },
      "entities:\n  Specter: {}\n",
      "r",
    );
    expect(refusals.length).toBeGreaterThanOrEqual(3);
  });
});
