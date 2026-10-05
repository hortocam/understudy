import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exprDependencies, loadRecipes, selectRecipe } from "../../src/config/layers/recipes.js";
import { ConfigLayerInvalidError, RecipeNotFoundError } from "../../src/errors.js";
import { makeProject } from "../helpers/project.js";
import { recipeFile } from "../fixtures/layers/docs03-examples.js";

function load(files: Record<string, string>): ReturnType<typeof loadRecipes> {
  const dir = makeProject(files);
  return loadRecipes(join(dir, "dynamic"), dir);
}

function refusal(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a refusal");
}

describe("recipes layer (FR-003)", () => {
  it("dynamic/<name>.yaml is recipe <name>; a recipe's seed is carried", () => {
    const recipes = load({ "dynamic/ci-small.yaml": recipeFile, "dynamic/load-test.yaml": "entities:\n  Event: { count: 5 }\n" });
    expect([...recipes.keys()]).toEqual(["ci-small", "load-test"]);
    expect(recipes.get("ci-small")?.seed).toBe(42);
    expect(recipes.get("load-test")?.seed).toBeUndefined();
    expect(recipes.get("ci-small")?.entities.Inventory?.perParent?.range).toEqual([10, 50]);
    expect(recipes.get("ci-small")?.generators.sectionCode?.choice).toHaveLength(7);
  });

  it("a missing dynamic/ folder is not an error", () => {
    expect(load({ "x.txt": "" }).size).toBe(0);
  });

  it("selecting an unknown recipe refuses naming it and listing the available ones", () => {
    const recipes = load({ "dynamic/ci-small.yaml": recipeFile });
    const error = refusal(() => selectRecipe(recipes, "ci-smal"));
    expect(error).toBeInstanceOf(RecipeNotFoundError);
    expect(error.message).toContain("ci-smal");
    expect(error.message).toContain("ci-small");
    expect(selectRecipe(recipes, "ci-small").name).toBe("ci-small");
  });

  it("two files with the same stem and different extensions refuse naming both", () => {
    const error = refusal(() =>
      load({ "dynamic/ci.yaml": "entities: {}\n", "dynamic/ci.json": "{\"entities\":{}}" }),
    );
    expect(error).toBeInstanceOf(ConfigLayerInvalidError);
    expect(error.message).toContain("ci.yaml");
    expect(error.message).toContain("ci.json");
  });

  it("a JSONata syntax error in an expr or a constraint refuses naming the field", () => {
    const badExpr = refusal(() =>
      load({ "dynamic/r.yaml": "entities:\n  A:\n    count: 1\n    fields:\n      price: { expr: \"cost *\" }\n" }),
    );
    expect(badExpr.message).toContain("entities.A.fields.price");
    const badConstraint = refusal(() =>
      load({ "dynamic/r.yaml": "entities:\n  A:\n    count: 1\n    constraints: [\"price >=\"]\n" }),
    );
    expect(badConstraint.message).toContain("entities.A.constraints[0]");
  });

  it("a collection entry that says neither how many nor 'source: import' refuses", () => {
    const error = refusal(() => load({ "dynamic/r.yaml": "entities:\n  A:\n    fields: {}\n" }));
    expect(error.message).toContain("entities.A");
    expect(error.message).toMatch(/count|perParent/);
  });

  it("an unknown key in a recipe refuses by name", () => {
    const error = refusal(() => load({ "dynamic/r.yaml": "entities:\n  A:\n    count: 1\n    cnt: 2\n" }));
    expect(error.message).toContain("cnt");
  });

  it("a cycle among expr fields refuses naming both fields", () => {
    const error = refusal(() =>
      load({
        "dynamic/r.yaml":
          "entities:\n  A:\n    count: 1\n    fields:\n      a: { expr: \"b + 1\" }\n      b: { expr: \"a + 1\" }\n",
      }),
    );
    expect(error).toBeInstanceOf(ConfigLayerInvalidError);
    expect(error.message).toContain("a");
    expect(error.message).toContain("b");
    expect(error.message).toMatch(/cycle/i);
  });
});

describe("expression dependencies", () => {
  it("names the sibling fields an expression reads, ignoring $-helpers and literals", () => {
    expect(exprDependencies("cost * $uniform(1.1, 2.5)")).toEqual(["cost"]);
    expect(exprDependencies("price - cost + $round(tax)")).toEqual(["cost", "price", "tax"]);
    expect(exprDependencies("qty > 0 ? a : b")).toEqual(["a", "b", "qty"]);
    expect(exprDependencies("1 + 2")).toEqual([]);
  });
});
