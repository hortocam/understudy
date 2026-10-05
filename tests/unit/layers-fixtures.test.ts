import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadFixtures } from "../../src/config/layers/fixtures.js";
import { ConfigLayerInvalidError, ConfigUnparseableError } from "../../src/errors.js";
import { makeProject } from "../helpers/project.js";
import { entitiesFile, lookupFile } from "../fixtures/layers/docs03-examples.js";

function load(files: Record<string, string>): ReturnType<typeof loadFixtures> {
  const dir = makeProject(files);
  return loadFixtures(join(dir, "static"), dir);
}

function refusal(files: Record<string, string>): Error {
  try {
    load(files);
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a refusal");
}

describe("fixtures layer (FR-001, FR-002)", () => {
  it("loads lookups and entity files into a stable, name-ordered set", () => {
    const set = load({
      "static/lookups/inventory-statuses.yaml": lookupFile,
      "static/entities/venues.yaml": entitiesFile,
      "static/entities/a-first.yaml": "entity: Zone\nrows:\n  - { id: 9, name: Pit }\n",
    });
    expect(set.lookups.map((t) => t.entity)).toEqual(["InventoryStatus"]);
    expect(set.lookups[0]?.rows).toHaveLength(4);
    expect(set.entities.map((t) => t.entity)).toEqual(["Zone", "Venue"]); // files by name, rows by file order
    expect(set.entities[1]?.rows[0]).toMatchObject({ id: 1, name: "Test Arena" });
  });

  it("a missing static/ folder — or lookups/ or entities/ alone — is not an error", () => {
    expect(load({ "other.txt": "x" })).toEqual({ lookups: [], entities: [] });
    const onlyLookups = load({ "static/lookups/s.yaml": lookupFile });
    expect(onlyLookups.entities).toEqual([]);
    expect(onlyLookups.lookups).toHaveLength(1);
    const onlyEntities = load({ "static/entities/v.yaml": entitiesFile });
    expect(onlyEntities.lookups).toEqual([]);
  });

  it("accepts YAML and JSON", () => {
    const set = load({ "static/entities/v.json": JSON.stringify({ entity: "Venue", rows: [{ id: 1, name: "A" }] }) });
    expect(set.entities[0]?.rows).toEqual([{ id: 1, name: "A" }]);
  });

  it("a malformed row refuses, naming the file and key", () => {
    const error = refusal({ "static/entities/v.yaml": "entity: Venue\nrows: not-a-list\n" });
    expect(error).toBeInstanceOf(ConfigLayerInvalidError);
    expect(error.message).toContain("static/entities/v.yaml");
    expect(error.message).toContain("rows");
  });

  it("an unknown key refuses by name", () => {
    const error = refusal({ "static/entities/v.yaml": "entity: Venue\nrows: [{id: 1}]\nbogus: 1\n" });
    expect(error).toBeInstanceOf(ConfigLayerInvalidError);
    expect(error.message).toContain("bogus");
  });

  it("unparseable YAML refuses naming the file", () => {
    const error = refusal({ "static/entities/v.yaml": "entity: [unclosed\n" });
    expect(error).toBeInstanceOf(ConfigUnparseableError);
    expect(error.message).toContain("v.yaml");
  });

  it("two files declaring the same (entity, id) refuse naming both", () => {
    const error = refusal({
      "static/entities/a.yaml": "entity: Venue\nrows: [{ id: 1, name: A }]\n",
      "static/entities/b.yaml": "entity: Venue\nrows: [{ id: 1, name: B }]\n",
    });
    expect(error.message).toContain("a.yaml");
    expect(error.message).toContain("b.yaml");
    expect(error.message).toMatch(/Venue/);
  });

  it("a row without the entity's identity field refuses", () => {
    const error = refusal({ "static/entities/v.yaml": "entity: Venue\nrows: [{ name: A }]\n" });
    expect(error.message).toContain("rows[0]");
    expect(error.message).toContain("id");
  });

  it("honours an explicit idField", () => {
    const set = load({ "static/entities/v.yaml": "entity: Venue\nidField: code\nrows: [{ code: V1, name: A }]\n" });
    expect(set.entities[0]?.idField).toBe("code");
  });
});
