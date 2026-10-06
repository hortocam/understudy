/**
 * FU — two distinct collections whose names differ only by case fuse into one SQLite table.
 *
 * SQLite compares table identifiers case-insensitively (ASCII: `sqlite3_stricmp`), so a resource
 * named `Foo` and one named `foo` addressed the SAME physical table. `disambiguateNames`
 * (`src/spec/resources.ts`) deduped by exact string, so neither collision was reported nor either
 * collection renamed: the mock started cleanly with resources `["Foo","foo"]` and a row POSTed to
 * `/foos` came back from `GET /bars` — silent data loss (constitution VI, the class the tool
 * exists to prevent).
 *
 * FR-007 precedent: exact duplicate names are never a silent fusion — every colliding collection
 * is renamed to a deterministic path-qualified name and the collision is reported. A case-folded
 * collision is the same defect one fold away, so it is handled the same way: both collections are
 * renamed and the collision is reported naming both paths and the chosen names. Rows must NOT
 * cross between `/foos` and `/bars` (asserted on real HTTP).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunningMock } from "../../src/index.js";
import { collectOperations } from "../../src/spec/operations.js";
import { loadSpec } from "../../src/spec/load.js";
import { deriveModel } from "../../src/spec/resources.js";
import { fixturePath, start } from "../helpers/mock.js";

const CASE_OPERATIONS = [
  "POST /foos",
  "GET /foos",
  "GET /foos/{id}",
  "POST /bars",
  "GET /bars",
  "GET /bars/{id}",
] as const;

/** ASCII-only lower-case, the fold SQLite uses for table identity (`sqlite3_stricmp`). */
const fold = (name: string): string => name.replace(/[A-Z]/g, (char) => char.toLowerCase());

let mock: RunningMock | undefined;

afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

async function create(baseUrl: string, collection: string, body: Record<string, unknown>): Promise<{ id: number }> {
  const response = await fetch(`${baseUrl}${collection}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: number };
}

describe("two collections differing only by case never fuse (FR-007 precedent)", () => {
  it("derivation: names are unique case-insensitively, and the collision is reported with both paths", async () => {
    const loaded = await loadSpec(fixturePath("case-collision-api.yaml"));
    const model = deriveModel(loaded.document, collectOperations(loaded.document));

    // Precondition: the fixture really does declare a case-folded pair of titles.
    const paths = model.resources.map((resource) => resource.collectionPath).sort();
    expect(paths).toEqual(["/bars", "/foos"]);

    // The invariant: no two resource names fold together, so no two tables are the same table.
    const folded = model.resources.map((resource) => fold(resource.name));
    expect(new Set(folded).size).toBe(folded.length);

    // The collision is reported, naming BOTH collection paths and the chosen names.
    const reported = model.ambiguities.filter((ambiguity) => ambiguity.kind === "duplicate-resource-name");
    expect(reported).toHaveLength(1);
    const detail = reported[0]?.detail ?? "";
    expect(detail).toContain("/foos");
    expect(detail).toContain("/bars");
    // The chosen (path-qualified) names, one per colliding path.
    for (const resource of model.resources) expect(detail).toContain(resource.name);
  });

  it("live: a row written to /foos does NOT come back from /bars", async () => {
    mock = await start({
      spec: fixturePath("case-collision-api.yaml"),
      operations: CASE_OPERATIONS,
      storeDir: mkdtempSync(join(tmpdir(), "understudy-case-collision-")),
    });

    const created = await create(mock.baseUrl, "/foos", { name: "from-foos" });

    // The defect: GET /bars returned the row created via POST /foos (one fused table).
    const bars = await fetch(`${mock.baseUrl}/bars`);
    expect(bars.status).toBe(200);
    expect(await bars.json()).toEqual([]);

    // The row is still served by the collection that owns it.
    const foos = await fetch(`${mock.baseUrl}/foos`);
    expect(await foos.json()).toEqual([expect.objectContaining({ id: created.id, name: "from-foos" })]);

    // ...and each side can be written and read independently.
    const bar = await create(mock.baseUrl, "/bars", { label: "from-bars" });
    expect(await (await fetch(`${mock.baseUrl}/foos`)).json()).toEqual([
      expect.objectContaining({ id: created.id, name: "from-foos" }),
    ]);
    expect(await (await fetch(`${mock.baseUrl}/bars`)).json()).toEqual([
      expect.objectContaining({ id: bar.id, label: "from-bars" }),
    ]);
  });

  it("negative control: two collections that do NOT case-collide keep their names verbatim", async () => {
    // The guard keys off the case-folded name, never off the presence of mixed case: a document
    // whose names are distinct under the fold is untouched (nothing is renamed spuriously).
    const loaded = await loadSpec(fixturePath("derivation-api.yaml"));
    const model = deriveModel(loaded.document, collectOperations(loaded.document));
    const names = model.resources.map((resource) => resource.name).sort();
    expect(names).toEqual(["Inventory", "Order", "OrderLine", "Ping", "Supplier", "Warehouse"]);
    expect(model.ambiguities.some((ambiguity) => ambiguity.kind === "duplicate-resource-name")).toBe(false);
  });

  it("is deterministic: the same document yields the same names every time (constitution III)", async () => {
    const loaded = await loadSpec(fixturePath("case-collision-api.yaml"));
    const live = collectOperations(loaded.document);
    const a = deriveModel(loaded.document, live).resources.map((resource) => `${resource.collectionPath}=${resource.name}`).sort();
    const b = deriveModel(loaded.document, live).resources.map((resource) => `${resource.collectionPath}=${resource.name}`).sort();
    expect(a).toEqual(b);
  });
});
