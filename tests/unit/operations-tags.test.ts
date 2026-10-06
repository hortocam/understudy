import { describe, expect, it } from "vitest";
import { loadSpec } from "../../src/spec/load.js";
import { collectOperations, selectOperations } from "../../src/spec/operations.js";
import { UnknownOperationError, UnderstudyError } from "../../src/errors.js";
import { fixturePath } from "../helpers/mock.js";

async function doc(name: string): Promise<Record<string, unknown>> {
  return (await loadSpec(fixturePath(name))).document;
}

const keys = (result: ReturnType<typeof selectOperations>): string[] => result.live.map((o) => `${o.method} ${o.path}`).sort();

describe("tag selector (D1, FR-002) — a third peer form", () => {
  it("the fixture has no operationId at all (the measured shape of the target document)", async () => {
    const operations = collectOperations(await doc("tags-api.yaml"));
    expect(operations.length).toBeGreaterThan(0);
    expect(operations.every((o) => o.operationId === undefined)).toBe(true);
  });

  it("a tag selects every operation carrying it, and the rest answer not-implemented", async () => {
    const result = selectOperations(await doc("tags-api.yaml"), ["Invoices"]);
    expect(keys(result)).toEqual(["GET /invoices", "GET /invoices/{id}"]);
    expect(result.notImplemented.length).toBe(4);
    expect(result.resolved.every((r) => r.form === "tag")).toBe(true);
    expect(result.forms).toEqual(["tag"]);
  });

  it("'Market_Orders' and the raw 'Market Orders' select the same set", async () => {
    const d = await doc("tags-api.yaml");
    const underscored = keys(selectOperations(d, ["Market_Orders"]));
    const raw = keys(selectOperations(d, ["Market Orders"]));
    expect(underscored).toEqual(["GET /market-orders", "GET /market-orders/{id}", "POST /market-orders"]);
    expect(raw).toEqual(underscored);
  });

  it("an ambiguous collapse ('Market Orders' and 'Market_Orders' both declared) is refused naming both", async () => {
    let error: unknown;
    try {
      selectOperations(await doc("tags-collision-api.yaml"), ["Market_Orders"]);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(UnderstudyError);
    expect((error as Error).message).toContain("Market Orders");
    expect((error as Error).message).toContain("Market_Orders");
  });

  it("the three forms are peers: an entry matching two forms is refused as ambiguous, naming the forms", async () => {
    const d = structuredClone(await doc("tags-api.yaml")) as { paths: Record<string, Record<string, Record<string, unknown>>> };
    d.paths["/venues"]!.get!.operationId = "Invoices"; // an operationId spelled like a tag
    let error: unknown;
    try {
      selectOperations(d, ["Invoices"]);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(UnderstudyError);
    expect((error as Error).message).toMatch(/operationId/);
    expect((error as Error).message).toMatch(/tag/);
  });

  it("method-path and tag forms can be mixed, each resolved by its own form", async () => {
    const result = selectOperations(await doc("tags-api.yaml"), ["GET /venues", "Invoices"]);
    expect(result.mixed).toBe(true);
    expect([...result.forms].sort()).toEqual(["method-path", "tag"]);
  });
});

describe("unknown entry", () => {
  it("is still refused by name", async () => {
    let error: unknown;
    try {
      selectOperations(await doc("tags-api.yaml"), ["NoSuchTag"]);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(UnknownOperationError);
    expect((error as Error).message).toContain("NoSuchTag");
  });
});
