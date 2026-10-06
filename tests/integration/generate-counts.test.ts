/**
 * US2 (FR-011, FR-013, FR-014, SC-004): a populated mock that was never hand-written. Counts are
 * exact, every record conforms to the document's schema — judged by the document's own validator on
 * what is in the STORE, not by the generator — and every rule kind does what it says.
 */
import { afterEach, describe, expect, it } from "vitest";
import { InvariantViolatedError } from "../../src/errors.js";
import type { RunningMock } from "../../src/index.js";
import { conformanceErrors } from "../../src/spec/conform.js";
import { renderRefusal } from "../../src/logging.js";
import { startGen } from "../helpers/project.js";

const mocks: RunningMock[] = [];
afterEach(async () => {
  await Promise.all(mocks.splice(0).map((m) => m.close()));
});

async function gen(recipe: string, options: Parameters<typeof startGen>[1] = {}): Promise<RunningMock> {
  const { mock } = await startGen(recipe, options);
  mocks.push(mock);
  return mock;
}

const rowsOf = (m: RunningMock, resource: string, origin = "generated") =>
  m.store.list(resource).filter((r) => r.origin === origin).map((r) => r.data as Record<string, unknown>);

describe("US2 — exact counts, every record conforming, every rule honoured", () => {
  it("2.1 an absolute count is exact; relative counts fall inside their range; fixtures stay alongside", async () => {
    const m = await gen("ci-small");
    expect(m.store.countByOrigin().Venue).toEqual({ static: 2, generated: 3 });
    const events = rowsOf(m, "Event");
    const perVenue = new Map<number, number>();
    for (const e of events) perVenue.set(e.venueId as number, (perVenue.get(e.venueId as number) ?? 0) + 1);
    expect(perVenue.size).toBe(5); // 2 fixture venues + 3 generated ones, each with children
    for (const n of perVenue.values()) {
      expect(n).toBeGreaterThanOrEqual(2);
      expect(n).toBeLessThanOrEqual(4);
    }
    expect(m.report.generation?.created.Venue).toEqual({ generated: 3 });
  });

  it("2.1 / SC-004: 100% of generated records conform to the document's schema — judged from the store", async () => {
    const m = await gen("ci-small");
    let checked = 0;
    for (const resource of m.report.resources) {
      for (const record of m.store.list(resource.name)) {
        expect(conformanceErrors(resource, record.data), `${resource.name} ${record.identity}`).toEqual([]);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(80);
  });

  it("2.2 a `choice` field only ever emits members of its set", async () => {
    const m = await gen("ci-small");
    const categories = new Set(rowsOf(m, "Event").map((e) => e.category));
    expect([...categories].every((c) => c === "music" || c === "sport")).toBe(true);
    expect(categories.size).toBe(2);
    const sections = new Set(rowsOf(m, "Inventory").map((r) => r.section));
    expect([...sections].every((s) => ["100", "101", "102", "200", "201", "FLOOR", "GA"].includes(s as string))).toBe(true);
  });

  it("2.3 a lookup field stores a real row of the table, and weights shape the draw", async () => {
    const m = await gen("ci-small");
    const known = new Set(m.store.listIdentities("InventoryStatus"));
    const status = rowsOf(m, "Inventory").map((r) => r.statusId as number);
    expect(status.every((s) => known.has(String(s)))).toBe(true);
    expect(status.every((s) => s !== 4)).toBe(true); // 'cancelled' has weight 0 (unlisted)
    const available = status.filter((s) => s === 1).length / status.length;
    expect(available).toBeGreaterThan(0.65);
    expect(available).toBeLessThan(0.95);
  });

  it("2.4 a calculated field is consistent with its siblings, and the invariant holds on every record", async () => {
    const m = await gen("ci-small");
    expect(rowsOf(m, "Inventory").length).toBeGreaterThan(40);
    for (const r of rowsOf(m, "Inventory")) {
      const cost = r.cost as number;
      const price = r.price as number;
      expect(price).toBeGreaterThanOrEqual(cost); // the invariant (FR-013)
      expect(price).toBeGreaterThanOrEqual(cost * 1.1 - 1e-9); // the calculation: cost × $uniform(1.1, 2.5)
      expect(price).toBeLessThanOrEqual(cost * 2.5 + 1e-9);
    }
  });

  it("2.5 an impossible invariant fails the run loudly, naming the rule, and stores NOTHING from the run", async () => {
    const error = await startGen("impossible").catch((e) => e as Error);
    expect(error).toBeInstanceOf(InvariantViolatedError);
    expect((error as Error).message).toContain("Inventory");
    expect((error as Error).message).toContain("price > 1000000");
    // FU: the human rendering is produced at the process boundary (the CLI), not written by
    // `createMock` to its `out` sink — that dual write was the source of the three-times print.
    // The loudness FR-013 demands is the named, rendered refusal, checked here via `renderRefusal`.
    expect(renderRefusal(error)).toContain("refusing to start");
    // a later start on the same project must not find a half-generated store
    const m = await gen("ci-small");
    expect(m.store.countByOrigin().Venue?.generated).toBe(3);
  });

  it("2.6 a collection with NO field rules is populated from the specification alone, and the report says which level supplied each field", async () => {
    const m = await gen("no-rules");
    const notes = rowsOf(m, "AuditNote");
    expect(notes).toHaveLength(20);
    expect(notes.every((n) => typeof n.text === "string" && (n.text as string).length > 0)).toBe(true);
    const fallbacks = m.report.generation?.fallbacks.filter((f) => f.collection === "AuditNote") ?? [];
    expect(fallbacks.length).toBeGreaterThan(0);
    expect(fallbacks.every((f) => f.level >= 5)).toBe(true);
    expect(fallbacks.find((f) => f.field === "text")?.rule).toBe("heuristic:name=text");
    expect(m.report.generation?.provenance.AuditNote?.text).toEqual({ "5": 20 });
  });

  it("a collection absent from the recipe is not generated (fixtures only)", async () => {
    const m = await gen("ci-small");
    expect(m.store.countByOrigin().Venue?.generated).toBe(3); // the run happened...
    expect(m.store.countByOrigin().AuditNote).toBeUndefined(); // ...and AuditNote was not part of it
  });
});
