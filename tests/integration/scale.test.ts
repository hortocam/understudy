/**
 * SC-008 (and SC-001): a dataset of a few thousand records across several collections is
 * generated and the mock is SERVING in well under a minute on a developer machine.
 *
 * The bar asserted is 30 s (the spec's "well under a minute"); the measured time is printed. The
 * heap figure is reported, and bounded per record: generation builds the whole run in memory so it
 * can be written atomically (a failed run stores nothing) — memory is therefore O(records) by
 * design here, and what is asserted is that the constant is small, not that it is flat.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { RunningMock } from "../../src/index.js";
import { startGen } from "../helpers/project.js";

const mocks: RunningMock[] = [];
afterEach(async () => {
  await Promise.all(mocks.splice(0).map((m) => m.close()));
});

const BAR_MS = 30_000;

describe("scale (SC-008)", () => {
  it("load-test: ≥ 5 000 records across 5 collections are generated and the mock answers /health inside the bar", async () => {
    const started = performance.now();
    const { mock } = await startGen("load-test");
    mocks.push(mock);
    const health = await fetch(`${mock.controlUrl}${mock.controlPrefix}/health`);
    const elapsed = performance.now() - started;
    expect(health.status).toBe(200);

    const generated = Object.values(mock.store.countByOrigin()).reduce((n, c) => n + (c.generated ?? 0), 0);
    const collections = Object.values(mock.store.countByOrigin()).filter((c) => (c.generated ?? 0) > 0).length;
    console.log(`scale: ${generated} generated records over ${collections} collections; generation+start+health ${Math.round(elapsed)} ms (bar ${BAR_MS} ms)`);
    expect(generated).toBeGreaterThanOrEqual(5000);
    expect(collections).toBeGreaterThanOrEqual(5);
    expect(elapsed).toBeLessThan(BAR_MS);

    // and it really serves: a page of a big collection, with no per-endpoint code involved
    const page = (await (await fetch(`${mock.baseUrl}/inventory?limit=25&offset=1000`)).json()) as unknown[];
    expect(page).toHaveLength(25);
  }, 60_000);

  it("heap use per record stays small (a documented O(records) constant, not unbounded growth)", async () => {
    const perRecord = async (n: number): Promise<number> => {
      (globalThis as { gc?: () => void }).gc?.();
      const before = process.memoryUsage().heapUsed;
      const { mock } = await startGen(undefined, { files: { "dynamic/flat.yaml": `seed: 1\nentities:\n  AuditNote: { count: ${n} }\n` }, config: "recipe: flat\n" });
      mocks.push(mock);
      const used = Math.max(0, process.memoryUsage().heapUsed - before);
      await mock.close();
      mocks.pop();
      return used / n;
    };
    const small = await perRecord(1000);
    const large = await perRecord(10000);
    console.log(`memory: ~${Math.round(small)} B/record at 1 000 records, ~${Math.round(large)} B/record at 10 000`);
    expect(large).toBeLessThan(50 * 1024); // 50 KB/record is generous; a leak or a quadratic structure would blow through it
  }, 90_000);
});
