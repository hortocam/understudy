import { describe, expect, it } from "vitest";
import type { LoadedRecipe } from "../../src/config/layers/recipes.js";
import { SequenceState } from "../../src/data/generators/sequence.js";
import { createRegistry } from "../../src/data/generators/registry.js";
import type { GenContext } from "../../src/data/generators/types.js";
import { createStream } from "../../src/data/seed.js";
import { UnknownGeneratorError } from "../../src/errors.js";
import { makeProject } from "../helpers/project.js";

const REF = new Date("2026-01-01T00:00:00.000Z");

function recipe(generators: LoadedRecipe["generators"], dir = "/"): LoadedRecipe {
  return { name: "r", file: "dynamic/r.yaml", dir, entities: {}, generators };
}

function ctx(collection = "Inventory", field = "section"): GenContext {
  const { rng, faker } = createStream(42, collection, REF);
  return { collection, field, schema: {}, record: {}, rng, faker, instant: REF, sequences: new SequenceState() };
}

describe("generator registry — one namespace (FR-012)", () => {
  it("built-ins and custom generators are addressed identically", async () => {
    const registry = await createRegistry(recipe({ sectionCode: { choice: ["100", "GA"] } }));
    expect(registry.has("sectionCode")).toBe(true);
    expect(registry.has("email")).toBe(true); // built-in
    expect(["100", "GA"]).toContain(registry.run("sectionCode", ctx()));
    expect(registry.run("email", ctx())).toMatch(/@/);
    expect(registry.has("nope")).toBe(false);
  });

  it("a custom `choice` generator honours weights; a custom `faker` and `seq` generator work like built-ins", async () => {
    const registry = await createRegistry(
      recipe({
        mostlyA: { choice: ["a", "b"], weights: [1, 0] },
        letter: { faker: "string.alpha", length: 1, casing: "upper" },
        rowNo: { seq: "rows", start: 100, step: 10 },
      }),
    );
    const c = ctx();
    expect(Array.from({ length: 20 }, () => registry.run("mostlyA", c))).toEqual(Array(20).fill("a"));
    expect(registry.run("letter", c)).toMatch(/^[A-Z]$/);
    expect([registry.run("rowNo", c), registry.run("rowNo", c), registry.run("rowNo", c)]).toEqual([100, 110, 120]);
  });

  it("an unknown name refuses naming it, never a silent undefined", async () => {
    const registry = await createRegistry(recipe({}));
    expect(() => registry.run("sectionCod", ctx())).toThrow(UnknownGeneratorError);
    expect(() => registry.run("sectionCod", ctx())).toThrow(/sectionCod/);
  });

  it("a custom name that collides with a built-in refuses, naming both", async () => {
    await expect(createRegistry(recipe({ email: { choice: ["x"] } }))).rejects.toThrow(/email/);
  });

  it("a plugin file is loaded config-relative and is given ONLY the collection's seeded stream (not faker, not the clock, not the store)", async () => {
    const dir = makeProject({
      "gens/ticket.mjs": "export default (ctx) => ({ keys: Object.keys(ctx).sort(), n: ctx.rng.int(1, 3) * 10 });\n",
    });
    const registry = await createRegistry(recipe({ ticket: { plugin: "./gens/ticket.mjs" } }, dir));
    const out = registry.run("ticket", ctx()) as { keys: string[]; n: number };
    expect(out.keys).toEqual(["collection", "field", "record", "rng", "schema"]);
    expect([10, 20, 30]).toContain(out.n);
  });

  it("a plugin's output is reproducible: it can depend only on the seeded stream", async () => {
    const dir = makeProject({ "p.mjs": "export default (ctx) => ctx.rng.int(0, 1_000_000);\n" });
    const registry = await createRegistry(recipe({ p: { plugin: "./p.mjs" } }, dir));
    const run = (): number[] => {
      const c = ctx();
      return Array.from({ length: 10 }, () => registry.run("p", c) as number);
    };
    expect(run()).toEqual(run());
  });

  it("a plugin that is not a function refuses at load, naming the file", async () => {
    const dir = makeProject({ "bad.mjs": "export default 42;\n" });
    await expect(createRegistry(recipe({ bad: { plugin: "./bad.mjs" } }, dir))).rejects.toThrow(/bad\.mjs/);
  });
});
