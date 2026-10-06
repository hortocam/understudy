/**
 * D7 — generation on a non-empty store: generate when empty, do nothing (and say so) when the
 * marker matches, refuse naming the mismatch when it differs. No silent regeneration, no silent skip.
 */
import { afterEach, describe, expect, it } from "vitest";
import { GenerationMarkerMismatchError } from "../../src/errors.js";
import type { RunningMock } from "../../src/index.js";
import { fixturesProject, startGen } from "../helpers/project.js";
import { serialiseStore } from "../helpers/serialize.js";

const mocks: RunningMock[] = [];
afterEach(async () => {
  await Promise.all(mocks.splice(0).map((m) => m.close()));
});

async function boot(recipe: string, options: Parameters<typeof startGen>[1] = {}) {
  const started = await startGen(recipe, options);
  mocks.push(started.mock);
  return started;
}

describe("restart on a populated store (D7)", () => {
  it("the same recipe + seed + configuration does NOT regenerate, says so, and leaves every row byte-identical", async () => {
    const first = await boot("ci-small");
    const before = serialiseStore(first.mock.store);
    expect(first.mock.store.countByOrigin().Venue?.generated).toBe(3); // generated for real, not an empty comparison
    await first.mock.close();
    mocks.pop();
    const out: string[] = [];
    const second = await boot("ci-small", { dir: first.dir, out });
    expect(second.mock.report.generation?.regenerated).toBe(false);
    expect(out.join("\n")).toContain("already applied to this store; nothing regenerated");
    expect(serialiseStore(second.mock.store)).toBe(before);
  });

  it("a changed seed refuses to start, naming the mismatch and the reset remedy", async () => {
    // The recipe carries its own seed, which would win over the configuration's: use one without.
    const noSeed = fixturesProject("gen-project")["dynamic/ci-small.yaml"]!.replace("seed: 42\n", "");
    const files = { "dynamic/noseed.yaml": noSeed };
    const first = await boot("noseed", { seed: 1, files });
    await first.mock.close();
    mocks.pop();
    const error = await startGen("noseed", { dir: first.dir, seed: 2, files }).catch((e) => e as Error);
    expect(error).toBeInstanceOf(GenerationMarkerMismatchError);
    expect((error as Error).message).toContain("seed");
    expect((error as Error).message).toContain("reset --to wipe");
  });

  it("a different recipe refuses naming the recipe; after a wipe the new recipe generates", async () => {
    const first = await boot("ci-small");
    await first.mock.close();
    mocks.pop();
    const error = await startGen("ci-small-plus", { dir: first.dir }).catch((e) => e as Error);
    expect(error).toBeInstanceOf(GenerationMarkerMismatchError);
    expect((error as Error).message).toContain("ci-small");
    // wipe through the control plane of a mock started WITHOUT a recipe, then regenerate
    const bare = await boot("", { dir: first.dir });
    const reset = await fetch(`${bare.mock.controlUrl}${bare.mock.controlPrefix}/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(reset.status).toBe(200);
    const summary = await bare.mock.generate({ recipe: "ci-small-plus" });
    expect(summary.regenerated).toBe(true);
    expect(summary.created.AuditNote).toEqual({ generated: 25 });
  });

  it("an edited recipe (same name, same seed) is a configuration mismatch, not a silent skip", async () => {
    const first = await boot("ci-small");
    await first.mock.close();
    mocks.pop();
    const edited = (await import("../helpers/project.js")).fixturesProject("gen-project")["dynamic/ci-small.yaml"]!.replace("count: 3", "count: 4");
    const error = await startGen("ci-small", { dir: first.dir, files: { "dynamic/ci-small.yaml": edited } }).catch((e) => e as Error);
    expect(error).toBeInstanceOf(GenerationMarkerMismatchError);
    expect((error as Error).message).toMatch(/configuration/);
  });
});
