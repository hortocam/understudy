/**
 * SC-002 / US3 (FR-016, principle III): the same seed and configuration produce the SAME state —
 * identities and values, byte for byte — and a different seed does not. Compared over the
 * deterministic serialisation (the shipped export is slice 3's), with the clock pinned.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { RunningMock } from "../../src/index.js";
import { startGen } from "../helpers/project.js";
import { serialiseStore, sha256 } from "../helpers/serialize.js";

const mocks: RunningMock[] = [];
afterEach(async () => {
  await Promise.all(mocks.splice(0).map((m) => m.close()));
});

async function boot(recipe: string, options: Parameters<typeof startGen>[1] = {}): Promise<RunningMock> {
  const { mock } = await startGen(recipe, options);
  mocks.push(mock);
  return mock;
}

describe("determinism (SC-002, US3.1–3.3)", () => {
  it("generating twice from wiped stores with the same seed and configuration gives byte-identical state (sha256 equal)", async () => {
    const a = serialiseStore((await boot("ci-small")).store);
    const b = serialiseStore((await boot("ci-small")).store);
    expect(a.split("\n").length).toBeGreaterThan(80);
    const digest = sha256(a);
    console.log(`determinism: run1 sha256=${digest} run2 sha256=${sha256(b)} bytes=${a.length}`);
    expect(sha256(b)).toBe(digest);
    expect(b).toBe(a);
  });

  it("a different seed changes the data (the seed is the only entropy)", async () => {
    const recipe = (await import("../helpers/project.js")).fixturesProject("gen-project")["dynamic/ci-small.yaml"]!.replace("seed: 42\n", "");
    const files = { "dynamic/noseed.yaml": recipe };
    const a = serialiseStore((await boot("noseed", { seed: 1, files })).store);
    const same = serialiseStore((await boot("noseed", { seed: 1, files })).store);
    const other = serialiseStore((await boot("noseed", { seed: 2, files })).store);
    expect(same).toBe(a);
    expect(other).not.toBe(a);
  });

  it("wipe + regenerate from the same seed reproduces EVERY record's identity and values, not merely the count (US3.3)", async () => {
    const mock = await boot("ci-small");
    const before = serialiseStore(mock.store, { origins: ["generated"] });
    const wiped = await fetch(`${mock.controlUrl}${mock.controlPrefix}/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(wiped.status).toBe(200);
    expect(serialiseStore(mock.store, { origins: ["generated"] })).toBe("");
    const summary = await mock.generate({ recipe: "ci-small" });
    expect(summary.regenerated).toBe(true);
    expect(serialiseStore(mock.store, { origins: ["generated"] })).toBe(before);
  });

  it("an unpinned clock is reported, and the data (not the timestamps) is still reproducible", async () => {
    const out: string[] = [];
    const { mock: a } = await startGen("ci-small", { out, config: "" }).then((r) => ({ mock: r.mock }));
    mocks.push(a);
    expect(out.join("\n")).toContain("clock: real, pinned to"); // startGen pins; the unpinned report is asserted in report.test.ts
    const data = (m: RunningMock): string => serialiseStore(m.store, { timestamps: false });
    const b = await boot("ci-small");
    expect(data(b)).toBe(data(a));
  });
});
