import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmptySelectionError, SpecInvalidError, SpecUnreadableError, UnknownOperationError } from "../../src/errors.js";
import { loadSpec } from "../../src/spec/load.js";
import { collectOperations, operationKey, selectOperations } from "../../src/spec/operations.js";

const fixture = (name: string): string => fileURLToPath(new URL(`../fixtures/spec-load/${name}`, import.meta.url));

function dig(value: unknown, ...path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadSpec", () => {
  it("resolves an external $ref and reports version and content hash", async () => {
    const loaded = await loadSpec(fixture("root.yaml"));

    expect(loaded.isUrl).toBe(false);
    expect(loaded.sourceVersion).toBe("3.0.3");
    expect(loaded.version).toMatch(/^3\.1/);
    expect(loaded.contentHash).toMatch(/^[0-9a-f]{64}$/);

    const idType = dig(
      loaded.document,
      "paths",
      "/widgets",
      "get",
      "responses",
      "200",
      "content",
      "application/json",
      "schema",
      "items",
      "properties",
      "id",
      "type",
    );
    expect(idType).toBe("integer");
    expect(dig(loaded.document, "x-ext")).toBeUndefined();
  });

  it("never fetches a URL when the path form was given", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await loadSpec(fixture("root.yaml"));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a missing document by name", async () => {
    await expect(loadSpec(fixture("does-not-exist.yaml"))).rejects.toBeInstanceOf(SpecUnreadableError);
    await expect(loadSpec(fixture("does-not-exist.yaml"))).rejects.toThrow(/does-not-exist\.yaml/);
  });

  it("refuses a document that is not OpenAPI", async () => {
    await expect(loadSpec(fixture("not-openapi.yaml"))).rejects.toBeInstanceOf(SpecInvalidError);
  });
});

describe("selectOperations", () => {
  it("produces the same operations from a 3.0 document and its 3.1 twin", async () => {
    const threeOh = await loadSpec(fixture("three-oh.yaml"));
    const threeOne = await loadSpec(fixture("three-one.yaml"));
    const keys = (document: Record<string, unknown>): string[] =>
      collectOperations(document)
        .map(operationKey)
        .sort();

    expect(keys(threeOh.document)).toEqual(keys(threeOne.document));
    expect(keys(threeOh.document)).toEqual(["GET /things", "GET /things/{id}"]);
  });

  it("splits the live set from the not-implemented set", async () => {
    const loaded = await loadSpec(fixture("root.yaml"));
    const selection = selectOperations(loaded.document, ["GET /widgets", "getWidget"]);

    expect(selection.live.map(operationKey).sort()).toEqual(["GET /widgets", "GET /widgets/{id}"]);
    expect(selection.notImplemented.map(operationKey)).toEqual(["POST /widgets"]);
  });

  it("refuses an unknown selection entry by name", async () => {
    const loaded = await loadSpec(fixture("root.yaml"));
    const error = (() => {
      try {
        selectOperations(loaded.document, ["GET /widgets", "DELETE /nope"]);
      } catch (caught) {
        return caught;
      }
      throw new Error("expected the selection to be refused");
    })();
    expect(error).toBeInstanceOf(UnknownOperationError);
    expect((error as Error).message).toContain("DELETE /nope");
  });

  it("refuses an empty selection", async () => {
    const loaded = await loadSpec(fixture("root.yaml"));
    expect(() => selectOperations(loaded.document, [])).toThrow(EmptySelectionError);
  });
});