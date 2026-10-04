import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadSpec } from "../../src/spec/load.js";
import { collectOperations } from "../../src/spec/operations.js";
import { buildStartupReport } from "../../src/spec/report.js";
import { deriveModel } from "../../src/spec/resources.js";

const fixture = (name: string): string => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

async function deriveFromFixture() {
  const loaded = await loadSpec(fixture("derivation-api.yaml"));
  const live = collectOperations(loaded.document);
  const model = deriveModel(loaded.document, live, {
    configuredRelationships: [{ from: "Order", to: "Inventory", field: "inventoryId" }],
  });
  return { loaded, live, model };
}

describe("resource derivation", () => {
  it("derives entities, identity fields and each relationship evidence rule", async () => {
    const { model } = await deriveFromFixture();
    const byName = new Map(model.resources.map((resource) => [resource.name, resource]));

    expect([...byName.keys()].sort()).toEqual(["Inventory", "Order", "OrderLine", "Ping", "Supplier", "Warehouse"]);

    const inventory = byName.get("Inventory");
    expect(inventory?.idField).toBe("id");
    expect(inventory?.idType).toBe("integer");
    expect(inventory?.nameSource).toBe("schema-title");
    expect(inventory?.collectionPath).toBe("/inventory");
    expect(inventory?.instancePath).toBe("/inventory/{id}");
    expect(inventory?.operations.create?.method).toBe("POST");
    expect(inventory?.listParams.map((param) => param.kind)).toEqual(["paging", "sort", "filter"]);

    expect(byName.get("Warehouse")?.idType).toBe("string");
    expect(byName.get("OrderLine")?.collectionPath).toBe("/orders/{id}/lines");
    expect(byName.get("OrderLine")?.instancePath).toBeUndefined();
    expect(byName.get("Ping")?.representationSchema).toBeUndefined();

    const find = (from: string, to: string) =>
      model.relationships.find((relationship) => relationship.from === from && relationship.to === to);
    expect(find("Order", "Inventory")).toMatchObject({ field: "inventoryId", evidence: "configured" });
    expect(find("Order", "Warehouse")).toMatchObject({ field: "warehouseId", evidence: "extension" });
    expect(find("Order", "Supplier")).toMatchObject({ field: "supplierId", evidence: "convention" });
    expect(find("OrderLine", "Order")).toMatchObject({ evidence: "nesting" });
    expect(model.relationships).toHaveLength(4);
    expect(model.relationships.every((relationship) => relationship.evidence)).toBe(true);

    const ambiguityKinds = model.ambiguities.map((ambiguity) => ambiguity.kind);
    expect(ambiguityKinds).toContain("route-without-resource");
    expect(model.ambiguities.some((ambiguity) => ambiguity.path === "/reports/{year}/{month}")).toBe(true);
    expect(ambiguityKinds).toContain("no-representation-schema");
    expect(model.ambiguities.some((ambiguity) => ambiguity.path === "/pings")).toBe(true);
  });

  it("builds a startup report carrying evidence on every inferred relationship", async () => {
    const { loaded, live, model } = await deriveFromFixture();
    const report = buildStartupReport({ spec: loaded, live, notSelected: [], model });

    expect(report.spec.source).toContain("derivation-api.yaml");
    expect(report.spec.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(report.clock).toEqual({ mode: "real" });
    expect(report.resources).toHaveLength(6);
    expect(report.relationships.length).toBeGreaterThan(0);
    expect(report.relationships.every((relationship) => relationship.evidence)).toBe(true);
    expect(report.ambiguities.length).toBeGreaterThan(0);
    expect(report.live).toHaveLength(live.length);
  });
});