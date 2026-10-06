/**
 * T044 (D1, FR-002): selecting by TAG works end to end for fixtures, on a document with no
 * `operationId` at all — the measured shape of the target (0 of 224).
 */
import { afterEach, describe, expect, it } from "vitest";
import { ConfigRefusedError } from "../../src/errors.js";
import type { RunningMock } from "../../src/index.js";
import { fixturePath } from "../helpers/mock.js";
import { startProject } from "../helpers/project.js";

let mock: RunningMock | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

const orders = "entity: MarketOrder\nrows:\n  - { id: 7, symbol: ABC }\n  - { id: 8, symbol: XYZ }\n";

describe("tag selector + fixtures", () => {
  for (const entry of ["Market_Orders", "Market Orders"]) {
    it(`'${entry}' selects the tag's operations and loads fixtures for the collection they derive`, async () => {
      ({ mock } = await startProject(
        { "static/entities/orders.yaml": orders },
        { spec: fixturePath("tags-api.yaml"), operations: [entry] },
      ));
      expect(mock.report.selection.forms).toEqual(["tag"]);
      const one = await fetch(`${mock.baseUrl}/market-orders/7`);
      expect(one.status).toBe(200);
      expect(await one.json()).toEqual({ id: 7, symbol: "ABC" });
      const list = (await (await fetch(`${mock.baseUrl}/market-orders`)).json()) as unknown[];
      expect(list).toHaveLength(2);
      expect(mock.store.countByOrigin()).toEqual({ MarketOrder: { static: 2 } });
      // a tag that was not selected answers not-implemented, distinct from not-found
      expect((await fetch(`${mock.baseUrl}/invoices`)).status).toBe(501);
    });
  }

  it("a fixture for a collection that the tag selection does not make live refuses, naming file and key", async () => {
    await expect(
      startProject(
        { "static/entities/invoices.yaml": "entity: Invoice\nrows:\n  - { id: 1, total: 10 }\n" },
        { spec: fixturePath("tags-api.yaml"), operations: ["Market_Orders"] },
      ),
    ).rejects.toThrow(/static\/entities\/invoices\.yaml: entity/);
    await expect(
      startProject({ "static/entities/invoices.yaml": "entity: Invoice\nrows:\n  - { id: 1, total: 10 }\n" }, { spec: fixturePath("tags-api.yaml"), operations: ["Market_Orders"] }),
    ).rejects.toBeInstanceOf(ConfigRefusedError);
  });
});
