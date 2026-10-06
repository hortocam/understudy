/**
 * US5 (FR-009, FR-015, SC-004): generated children attach to real parents, with per-parent counts
 * that follow their stated distribution, and an undetermined link is reported — never acted on.
 */
import { afterEach, describe, expect, it } from "vitest";
import { GenerationRefusedError } from "../../src/errors.js";
import type { RunningMock } from "../../src/index.js";
import { fixturePath } from "../helpers/mock.js";
import { allOperations, startGen, startProject } from "../helpers/project.js";
import { serialiseStore } from "../helpers/serialize.js";

const mocks: RunningMock[] = [];
afterEach(async () => {
  await Promise.all(mocks.splice(0).map((m) => m.close()));
});

async function gen(recipe: string, options: Parameters<typeof startGen>[1] = {}): Promise<RunningMock> {
  const { mock } = await startGen(recipe, options);
  mocks.push(mock);
  return mock;
}

const data = (m: RunningMock, resource: string, origin?: string) =>
  m.store.list(resource).filter((r) => origin === undefined || r.origin === origin).map((r) => r.data as Record<string, unknown>);

describe("US5 — children attach to real parents", () => {
  it("5.1 / SC-004: every child references a parent that exists — zero orphans, checked against the store", async () => {
    const m = await gen("ci-small");
    const venues = new Set(m.store.listIdentities("Venue"));
    const events = new Set(m.store.listIdentities("Event"));
    expect(data(m, "Event").every((e) => venues.has(String(e.venueId)))).toBe(true);
    expect(data(m, "Inventory").every((i) => events.has(String(i.eventId)))).toBe(true);
    expect(m.store.countByOrigin().Inventory?.generated).toBeGreaterThan(40);
  });

  it("5.2 each parent's child count falls inside the declared range and is reproducible from the seed", async () => {
    const counts = async (): Promise<Map<number, number>> => {
      const m = await gen("ci-small");
      const per = new Map<number, number>();
      for (const i of data(m, "Inventory")) per.set(i.eventId as number, (per.get(i.eventId as number) ?? 0) + 1);
      return per;
    };
    const a = await counts();
    for (const n of a.values()) {
      expect(n).toBeGreaterThanOrEqual(5);
      expect(n).toBeLessThanOrEqual(12);
    }
    expect(a.size).toBeGreaterThan(5);
    expect([...(await counts())]).toEqual([...a]);
  });

  it("5.3 a stated distribution shapes the counts: zipf piles parents toward the minimum, uniform does not", async () => {
    const share = async (distribution: "uniform" | "zipf"): Promise<number> => {
      const recipe = `seed: 5\nentities:\n  Venue: { count: 400 }\n  Event:\n    perParent: { entity: Venue, range: [10, 50], distribution: ${distribution} }\n`;
      const { mock } = await startGen(undefined, { files: { "dynamic/dist.yaml": recipe }, config: "recipe: dist\n" });
      mocks.push(mock);
      const per = new Map<number, number>();
      for (const e of data(mock, "Event", "generated")) per.set(e.venueId as number, (per.get(e.venueId as number) ?? 0) + 1);
      const counts = [...per.values()];
      await mock.close();
      mocks.pop();
      return counts.filter((n) => n <= 12).length / counts.length; // parents at the low end of [10, 50]
    };
    const zipf = await share("zipf");
    const uniform = await share("uniform");
    // P(count <= 12) is (1 + 1/2 + 1/3) / H(41) = 0.42 under zipf, and 3/41 = 0.07 under uniform
    expect(zipf).toBeGreaterThan(0.35);
    expect(uniform).toBeLessThan(0.15); // 3 of 41 values
  });

  it("5.4 children attach to FIXTURE parents, and the fixture rows are untouched byte for byte", async () => {
    const before = await gen("ci-small");
    const staticBefore = serialiseStore(before.store, { origins: ["static"] });
    const fixtureEvents = data(before, "Inventory").filter((i) => i.eventId === 1 || i.eventId === 2);
    expect(fixtureEvents.length).toBeGreaterThan(0); // fixture events 1 and 2 were parents too
    expect(serialiseStore(before.store, { origins: ["static"] })).toBe(staticBefore);
    expect(before.store.countByOrigin().Event?.static).toBe(2);
  });

  it("a DECIDED link whose parent collection is empty refuses, naming both collections — never an invented parent", async () => {
    // No Event fixtures and Event is not generated: Inventory.eventId (required, decided) has no parent to attach to.
    const empty = await startProject(
      { "dynamic/orphans.yaml": "entities:\n  Inventory: { count: 5 }\n" },
      { config: "recipe: orphans\n" },
    ).catch((e) => e as Error);
    expect(empty).toBeInstanceOf(GenerationRefusedError);
    expect((empty as Error).message).toContain("Inventory");
    expect((empty as Error).message).toContain("Event");
  });

  it("an UNDETERMINED link is not acted on: no foreign key, the field takes its own precedence, and it is in the report", async () => {
    const spec = fixturePath("collisions-api.yaml");
    const out: string[] = [];
    const { mock } = await startProject(
      { "dynamic/orders.yaml": "entities:\n  Order: { count: 12 }\n" },
      { spec, operations: await allOperations(spec), config: "recipe: orders\n", mock: { out: (t: string) => out.push(t) } },
    );
    mocks.push(mock);
    const orders = data(mock, "Order", "generated");
    expect(orders).toHaveLength(12);
    expect(orders.every((o) => typeof o.eventId === "number" && typeof o.primaryEventId === "number")).toBe(true); // generated, not attached
    expect(mock.store.countByOrigin().Event).toBeUndefined(); // no Event rows exist, and none were needed
    expect(out.join("\n")).toContain("undetermined links");
  });
});

describe("perParent over an empty parent is said, not silent", () => {
  it("notes that no children were generated because the parent has no records", async () => {
    const { mock } = await startGen("empty-parent", {
      project: "gen-empty-parent",
    });
    mocks.push(mock);
    expect(mock.store.countByOrigin().Event?.generated ?? 0).toBe(0);
    const notes = mock.report.generation?.notes ?? [];
    expect(notes.some((n) => n.includes("Event") && n.includes("Venue") && /no .*record/.test(n))).toBe(true);
  });
});
