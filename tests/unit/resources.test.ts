import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderStartupReport } from "../../src/logging.js";
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

  it("says so when a live list operation declares no query parameters (FR-007)", async () => {
    const { model } = await deriveFromFixture();

    // /inventory declares paging/sort/filter params, so it is NOT ambiguous.
    expect(model.ambiguities.some((ambiguity) => ambiguity.path === "/inventory")).toBe(false);

    // Every other collection has a live list op with zero declared query parameters;
    // plan.md "Derivation rules" → List semantics and data-model.md §1 require it reported.
    for (const path of ["/orders", "/warehouses", "/suppliers"]) {
      const ambiguity = model.ambiguities.find(
        (candidate) => candidate.kind === "no-list-parameters" && candidate.path === path,
      );
      expect(ambiguity, `${path} declares no list parameters and must be called out`).toBeDefined();
      expect(ambiguity?.detail).toContain("full collection");
    }
  });

  it("reads list parameters declared at the path-item level, not only on the operation (FR-007)", async () => {
    const loaded = await loadSpec(fixture("path-params-api.yaml"));
    const live = collectOperations(loaded.document);
    const model = deriveModel(loaded.document, live);
    const byName = new Map(model.resources.map((resource) => [resource.name, resource]));

    // OpenAPI "Fixed Fields": a Path Item Object's `parameters` are inherited by every
    // operation on the path. /widgets declares limit+sort at the PATH level only.
    const widget = byName.get("Widget");
    expect(widget?.listParams.map((param) => param.name).sort()).toEqual(["limit", "sort"]);
    // ...so the report must NOT claim the full collection is returned unpaged/unsorted.
    expect(model.ambiguities.some((ambiguity) => ambiguity.kind === "no-list-parameters" && ambiguity.path === "/widgets")).toBe(false);

    // /gadgets mixes levels: `sort` comes from the path, `limit` is redeclared at the
    // operation level (same name+location, so it overrides), and `name` is operation-only.
    const gadget = byName.get("Gadget");
    expect(gadget?.listParams.map((param) => param.name).sort()).toEqual(["limit", "name", "sort"]);
    expect(gadget?.listParams.find((param) => param.name === "limit")?.required).toBe(true);
    expect(model.ambiguities.some((ambiguity) => ambiguity.kind === "no-list-parameters" && ambiguity.path === "/gadgets")).toBe(false);
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

  it("renders the declared list parameters a human needs to read FR-007", async () => {
    const { loaded, live, model } = await deriveFromFixture();
    const report = buildStartupReport({ spec: loaded, live, notSelected: [], model });
    const text = renderStartupReport(report);
    const lines = text.split("\n");

    const inventoryEntity = lines.find((line) => line.includes("(/inventory instance"));
    expect(inventoryEntity).toContain("params=[limit:paging,sort:sort,name:filter]");

    const ordersEntity = lines.find((line) => line.includes("(/orders instance"));
    expect(ordersEntity).toContain("params=[]");
  });
});
describe("duplicate derived names (FR-007: never a silent fusion)", () => {
  async function derive() {
    const loaded = await loadSpec(fixture("duplicate-names-api.yaml"));
    const live = collectOperations(loaded.document);
    return deriveModel(loaded.document, live, {});
  }

  it("derives one resource per collection, every name unique", async () => {
    const model = await derive();
    expect(model.resources).toHaveLength(4);
    const names = model.resources.map((resource) => resource.name);
    expect(new Set(names).size).toBe(4);
    expect(model.resources.map((resource) => resource.collectionPath).sort()).toEqual([
      "/accounts/{accountId}/invoices",
      "/blogs/tags",
      "/invoices",
      "/shops/tags",
    ]);
  });

  it("keeps each colliding resource's own identity field and paging", async () => {
    const model = await derive();
    const at = (path: string) => model.resources.find((resource) => resource.collectionPath === path);
    expect(at("/invoices")?.idField).toBe("id");
    expect(at("/accounts/{accountId}/invoices")?.idField).toBe("invoiceId");
    expect(at("/invoices")?.pagingStyle).not.toBe(at("/accounts/{accountId}/invoices")?.pagingStyle);
  });

  it("is deterministic regardless of path order", async () => {
    const a = (await derive()).resources.map((r) => `${r.collectionPath}=${r.name}`).sort();
    const b = (await derive()).resources.map((r) => `${r.collectionPath}=${r.name}`).sort();
    expect(a).toEqual(b);
  });

  it("reports every collision, naming the colliding collection paths", async () => {
    const model = await derive();
    const reported = model.ambiguities.filter((ambiguity) => ambiguity.kind === "duplicate-resource-name");
    expect(reported.map((ambiguity) => ambiguity.subject).sort()).toEqual(["Invoice", "Tag"]);
    const invoice = reported.find((ambiguity) => ambiguity.subject === "Invoice");
    expect(invoice?.detail).toContain("/invoices");
    expect(invoice?.detail).toContain("/accounts/{accountId}/invoices");
    const tag = reported.find((ambiguity) => ambiguity.subject === "Tag");
    expect(tag?.detail).toContain("/shops/tags");
    expect(tag?.detail).toContain("/blogs/tags");
  });
});
describe("names that differ only by case (the same fusion one fold away)", () => {
  /** ASCII-only lower-case, the fold SQLite applies to table identity (`sqlite3_stricmp`). */
  const fold = (name: string): string => name.replace(/[A-Z]/g, (char) => char.toLowerCase());

  async function derive() {
    const loaded = await loadSpec(fixture("case-collision-api.yaml"));
    const live = collectOperations(loaded.document);
    return deriveModel(loaded.document, live, {});
  }

  it("renames both colliding collections so no two names fold together", async () => {
    const model = await derive();
    expect(model.resources.map((r) => r.collectionPath).sort()).toEqual(["/bars", "/foos"]);
    const folded = model.resources.map((r) => fold(r.name));
    expect(new Set(folded).size).toBe(folded.length);
  });

  it("reports the collision with both paths and the chosen names", async () => {
    const model = await derive();
    const reported = model.ambiguities.filter((ambiguity) => ambiguity.kind === "duplicate-resource-name");
    expect(reported).toHaveLength(1);
    const detail = reported[0]?.detail ?? "";
    expect(detail).toContain("/foos");
    expect(detail).toContain("/bars");
    // The report names the ORIGINAL colliding names the document declared (`Foo`, `foo`)...
    expect(detail).toContain("Foo");
    expect(detail).toContain("foo");
    // ...and the chosen names, one per colliding path.
    for (const resource of model.resources) expect(detail).toContain(resource.name);
    // The original names are not the chosen ones, so the collision is what is named, not the fix.
    expect(model.resources.map((r) => r.name)).not.toContain("Foo");
    expect(model.resources.map((r) => r.name)).not.toContain("foo");
  });

  it("is deterministic regardless of path order", async () => {
    const a = (await derive()).resources.map((r) => `${r.collectionPath}=${r.name}`).sort();
    const b = (await derive()).resources.map((r) => `${r.collectionPath}=${r.name}`).sort();
    expect(a).toEqual(b);
  });
});
