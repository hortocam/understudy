import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildGenerationPlan } from "../../src/data/plan.js";
import type { LoadedRecipe } from "../../src/config/layers/recipes.js";
import { loadSpec } from "../../src/spec/load.js";
import { collectOperations } from "../../src/spec/operations.js";
import { deriveModel } from "../../src/spec/resources.js";
import type { DerivedModel, Relationship, Resource } from "../../src/spec/types.js";
import { fixturePath } from "../helpers/mock.js";

async function derive(fixture: string): Promise<DerivedModel> {
  const loaded = await loadSpec(fixturePath(fixture));
  return deriveModel(loaded.document, collectOperations(loaded.document));
}

function res(name: string): Resource {
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
  };
}

function link(from: string, to: string, field = `${to.toLowerCase()}Id`, status: Relationship["status"] = "decided"): Relationship {
  return { from, to, field, cardinality: "one", evidence: "convention", status };
}

function recipe(entities: LoadedRecipe["entities"]): LoadedRecipe {
  return { name: "r", file: "dynamic/r.yaml", dir: "/", entities, generators: {} };
}

describe("generation plan: order (FR-009)", () => {
  it("a collection is generated after the collections it references", async () => {
    const model = await derive("collisions-api.yaml");
    const { order } = buildGenerationPlan({ model });
    const at = (n: string): number => order.indexOf(n);
    expect(at("Venue")).toBeLessThan(at("Event")); // Event.venueId -> Venue
    expect(at("Order")).toBeLessThan(at("Listing")); // Listing.orderId -> Order
    expect([...order].sort()).toEqual(["Customer", "Event", "Listing", "Order", "Venue"]);
  });

  it("ties break by collection NAME, never by the order resources or keys were declared in (SC-007)", () => {
    const names = ["Zeta", "Alpha", "Mid", "Beta"];
    const forward = buildGenerationPlan({ model: { resources: names.map(res), relationships: [], ambiguities: [] } }).order;
    const reversed = buildGenerationPlan({ model: { resources: [...names].reverse().map(res), relationships: [], ambiguities: [] } }).order;
    expect(forward).toEqual(["Alpha", "Beta", "Mid", "Zeta"]);
    expect(reversed).toEqual(forward);
  });

  it("an UNDETERMINED link is not an ordering edge: it orders nothing", () => {
    const resources = [res("A"), res("B")];
    const decided = buildGenerationPlan({ model: { resources, relationships: [link("A", "B")], ambiguities: [] } }).order;
    const undetermined = buildGenerationPlan({ model: { resources, relationships: [link("A", "B", "bId", "undetermined")], ambiguities: [] } }).order;
    expect(decided).toEqual(["B", "A"]);
    expect(undetermined).toEqual(["A", "B"]); // name order only; the link constrained nothing
  });
});

describe("generation plan: cycles are reported, never deadlocked (FR-008)", () => {
  it("matches the hand-authored golden: members and the forward (unresolved) links", async () => {
    const golden = JSON.parse(readFileSync(fixturePath("golden/inference-cycle.json"), "utf8")) as {
      plan: { order: string[]; cycles: Array<{ members: string[]; unresolved: string[] }> };
    };
    const plan = buildGenerationPlan({ model: await derive("cycle-api.yaml") });
    expect({ order: plan.order, cycles: plan.cycles }).toEqual(golden.plan);
  });

  it("a self-referencing collection is a one-member cycle whose link is unresolved", () => {
    const plan = buildGenerationPlan({
      model: { resources: [res("Node")], relationships: [link("Node", "Node", "parentNodeId")], ambiguities: [] },
    });
    expect(plan.cycles).toEqual([{ members: ["Node"], unresolved: ["Node.parentNodeId"] }]);
    expect(plan.order).toEqual(["Node"]);
  });

  it("scales: a 10 000-link chain orders without recursion or a stack overflow, parents first", () => {
    const n = 10_001;
    const resources = Array.from({ length: n }, (_, i) => res(`R${String(i).padStart(5, "0")}`));
    const relationships = resources.slice(1).map((r, i) => link(r.name, (resources[i] as Resource).name));
    const started = Date.now();
    const plan = buildGenerationPlan({ model: { resources, relationships, ambiguities: [] } });
    expect(plan.order).toHaveLength(n);
    expect(plan.order[0]).toBe("R00000");
    expect(plan.order[n - 1]).toBe(`R${String(n - 1).padStart(5, "0")}`);
    expect(plan.cycles).toEqual([]);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("a 10 000-member cycle is also handled iteratively", () => {
    const n = 10_000;
    const resources = Array.from({ length: n }, (_, i) => res(`R${String(i).padStart(5, "0")}`));
    const relationships = resources.map((r, i) => link(r.name, (resources[(i + 1) % n] as Resource).name));
    const plan = buildGenerationPlan({ model: { resources, relationships, ambiguities: [] } });
    expect(plan.cycles).toHaveLength(1);
    expect(plan.cycles[0]?.members).toHaveLength(n);
  });
});

describe("generation plan: counts and refusals", () => {
  it("reads absolute and per-parent counts from the recipe, resolving the link field from the decided link", async () => {
    const model = await derive("collisions-api.yaml");
    const plan = buildGenerationPlan({
      model,
      recipe: recipe({
        Venue: { count: 3 },
        Event: { perParent: { entity: "Venue", range: [2, 4], distribution: "zipf" } },
        Customer: { source: "import" },
      }),
    });
    expect(plan.refusals).toEqual([]);
    expect(plan.counts.Venue).toEqual({ kind: "absolute", n: 3 });
    expect(plan.counts.Event).toEqual({ kind: "perParent", parent: "Venue", field: "venueId", range: [2, 4], distribution: "zipf" });
    expect(plan.counts.Customer).toEqual({ kind: "import" });
    expect(plan.counts.Order).toBeUndefined(); // not in the recipe: not generated
  });

  it("perParent with no DECIDED link to that parent refuses, naming both collections and how to pin it", async () => {
    const model = await derive("collisions-api.yaml");
    const plan = buildGenerationPlan({ model, recipe: recipe({ Order: { perParent: { entity: "Event", range: [1, 2] } } }) });
    // Order -> Event is UNDETERMINED (eventId / viagogoEventId / primaryEventId): not acted on.
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0]).toMatchObject({ file: "dynamic/r.yaml", key: "entities.Order.perParent.entity" });
    expect(plan.refusals[0]?.cause).toMatch(/Order/);
    expect(plan.refusals[0]?.cause).toMatch(/Event/);
    expect(plan.refusals[0]?.cause).toMatch(/relations/);
  });

  it("perParent with two decided links to the same parent refuses rather than choosing one", () => {
    const model: DerivedModel = {
      resources: [res("Parent"), res("Child")],
      relationships: [link("Child", "Parent", "aParentId"), link("Child", "Parent", "bParentId")],
      ambiguities: [],
    };
    const plan = buildGenerationPlan({ model, recipe: recipe({ Child: { perParent: { entity: "Parent", range: [1, 1] } } }) });
    expect(plan.refusals[0]?.cause).toMatch(/aParentId/);
    expect(plan.refusals[0]?.cause).toMatch(/bParentId/);
  });
});

describe("duplicate derived names reach the plan whole (mirror of the opt-in live assertion)", () => {
  it("plan.order covers every derived collection — none vanishes by name", async () => {
    const model = await derive("duplicate-names-api.yaml");
    const { order } = buildGenerationPlan({ model });
    expect(model.resources).toHaveLength(4);
    expect(order).toHaveLength(model.resources.length);
    expect(new Set(order).size).toBe(model.resources.length);
  });
});
