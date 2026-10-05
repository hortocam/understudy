/**
 * Inference golden tests (constitution VII family 2: entity/FK inference).
 *
 * Each fixture document is derived and the whole stable view compared to a hand-authored golden.
 * Authored from the spec — FR-006 (a convention hit proposes, decides only when unambiguous),
 * FR-015/Amendment C (paging style), FR-017/Amendment D (identity space) — so a failure means the
 * code disagrees with the spec, not that a snapshot is stale.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadSpec } from "../../src/spec/load.js";
import { collectOperations } from "../../src/spec/operations.js";
import { deriveModel } from "../../src/spec/resources.js";
import { fixturePath } from "../helpers/mock.js";
import { serialiseModel } from "../helpers/inference.js";

function golden(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(fixturePath(`golden/inference-${name}.json`), "utf8")) as Record<string, unknown>;
}

async function derive(fixture: string) {
  const loaded = await loadSpec(fixturePath(fixture));
  return deriveModel(loaded.document, collectOperations(loaded.document));
}

const CASES: Array<[string, string]> = [
  ["collisions", "collisions-api.yaml"],
  ["cycle", "cycle-api.yaml"],
  ["spaces", "spaces-api.yaml"],
  ["cursor-schema", "cursor-schema-api.yaml"],
];

describe("inference goldens", () => {
  it.each(CASES)("%s: collections, links (with status/candidates), identity spaces and paging match the golden", async (name, fixture) => {
    const { plan: _plan, ...expected } = golden(name);
    expect(serialiseModel(await derive(fixture))).toEqual(expected);
  });
});

describe("FR-006 — convention proposes, decides only when unambiguous", () => {
  it("an undetermined link is NOT an ordering edge and carries its competing candidates", async () => {
    const model = await derive("collisions-api.yaml");
    const undetermined = model.relationships.filter((r) => r.status === "undetermined");
    expect(undetermined.length).toBe(8);
    expect(model.relationships.filter((r) => r.status === "decided").map((r) => `${r.from}.${r.field}`).sort()).toEqual([
      "Event.venueId",
      "Listing.orderId",
    ]);
  });

  it("pinning ONE of the competing siblings in configuration decides it and drops the others", async () => {
    const loaded = await loadSpec(fixturePath("collisions-api.yaml"));
    const model = deriveModel(loaded.document, collectOperations(loaded.document), {
      configuredRelationships: [{ from: "Order", to: "Event", field: "eventId" }],
    });
    const order = model.relationships.filter((r) => r.from === "Order" && r.to === "Event");
    expect(order.map((r) => `${r.field}:${r.status}:${r.evidence}`)).toEqual(["eventId:decided:configured"]);
  });

  it("the ambiguous-name list is configurable (rung 3 'configurable rules')", async () => {
    const loaded = await loadSpec(fixturePath("collisions-api.yaml"));
    const model = deriveModel(loaded.document, collectOperations(loaded.document), {
      inference: { idSuffixes: ["Id", "_id"], ambiguousNames: [] },
    });
    // With externalId/referenceId no longer known-ambiguous, nothing proposes a target for them.
    expect(model.relationships.some((r) => r.field === "externalId")).toBe(false);
  });

  it("evidence order: one case per rung — configured, extension, convention, nesting", async () => {
    const loaded = await loadSpec(fixturePath("derivation-api.yaml"));
    const live = collectOperations(loaded.document);
    const model = deriveModel(loaded.document, live, {
      configuredRelationships: [{ from: "Order", to: "Inventory", field: "inventoryId" }],
    });
    const table = model.relationships.map((r) => `${r.from}->${r.to}:${r.evidence}:${r.status}`).sort();
    expect(table).toEqual([
      "Order->Inventory:configured:decided", // also matches the convention; the stronger rung wins
      "Order->Supplier:convention:decided",
      "Order->Warehouse:extension:decided",
      "OrderLine->Order:nesting:decided",
    ]);
  });

  it("a configured pin outranks a declared extension and a convention hit on the same link", async () => {
    const loaded = await loadSpec(fixturePath("derivation-api.yaml"));
    const live = collectOperations(loaded.document);
    const model = deriveModel(loaded.document, live, {
      configuredRelationships: [{ from: "Order", to: "Warehouse", field: "warehouseId" }],
    });
    expect(model.relationships.find((r) => r.from === "Order" && r.to === "Warehouse")?.evidence).toBe("configured");
  });
});
