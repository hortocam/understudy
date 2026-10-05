/**
 * SC-007 / US3.4 (research §1 "the trap"): adding an UNRELATED collection to a recipe leaves every
 * existing collection's generated records byte-identical. A shared random stream would pass the
 * double-run determinism test and fail this one — which is why this test exists as its own file.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { RunningMock } from "../../src/index.js";
import { startGen } from "../helpers/project.js";
import { serialiseStore } from "../helpers/serialize.js";

const mocks: RunningMock[] = [];
afterEach(async () => {
  await Promise.all(mocks.splice(0).map((m) => m.close()));
});

async function existing(recipe: string): Promise<{ existing: string; mock: RunningMock }> {
  const { mock } = await startGen(recipe);
  mocks.push(mock);
  return { existing: serialiseStore(mock.store, { resources: ["Venue", "Event", "Inventory", "InventoryStatus"] }), mock };
}

describe("independence (SC-007, US3.4)", () => {
  it("adding AuditNote — which sorts BEFORE every existing collection and is declared FIRST in the recipe — moves nothing", async () => {
    const base = await existing("ci-small");
    const plus = await existing("ci-small-plus");
    expect(plus.mock.store.countByOrigin().AuditNote?.generated).toBe(25); // it really was generated
    expect(base.existing.split("\n").length).toBeGreaterThan(80);
    expect(plus.existing).toBe(base.existing);
  });

  it("declared LAST in the recipe file makes no difference either", async () => {
    const base = await existing("ci-small");
    const last = await existing("ci-small-plus-last");
    expect(last.mock.store.countByOrigin().AuditNote?.generated).toBe(25);
    expect(last.existing).toBe(base.existing);
  });

  it("the new collection's own records are reproducible too", async () => {
    const a = serialiseStore((await existing("ci-small-plus")).mock.store, { resources: ["AuditNote"] });
    const b = serialiseStore((await existing("ci-small-plus")).mock.store, { resources: ["AuditNote"] });
    expect(a.length).toBeGreaterThan(0);
    expect(a).toBe(b);
  });
});
