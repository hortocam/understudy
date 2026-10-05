import { describe, expect, it } from "vitest";
import { createClock } from "../../src/clock.js";
import { ReservedConfigError } from "../../src/errors.js";

describe("clock seam (FR-019, principle X)", () => {
  it("reports the real mode and that it is unpinned by default", () => {
    const clock = createClock();
    expect(clock.mode).toBe("real");
    expect(clock.pinned).toBe(false);
  });

  it("with clock.start, every read is exactly that instant and never advances", async () => {
    const clock = createClock({ mode: "real", start: "2026-01-02T03:04:05.000Z" });
    expect(clock.pinned).toBe(true);
    const run = clock.startRun();
    const first = run.now().toISOString();
    await new Promise((r) => setTimeout(r, 15));
    expect(first).toBe("2026-01-02T03:04:05.000Z");
    expect(run.now().toISOString()).toBe(first);
    expect(clock.now().toISOString()).toBe(first);
  });

  it("without clock.start, a run reads the clock once: every later read in the run is the same instant", async () => {
    const clock = createClock();
    const run = clock.startRun();
    const first = run.now().getTime();
    await new Promise((r) => setTimeout(r, 15));
    expect(run.now().getTime()).toBe(first);
    // a later run is a later instant (the unpinned clock is real)
    expect(clock.startRun().now().getTime()).toBeGreaterThan(first);
  });

  it("refuses the virtual mode naming the mode", () => {
    expect(() => createClock({ mode: "virtual" })).toThrow(ReservedConfigError);
    expect(() => createClock({ mode: "virtual" })).toThrow(/virtual/);
  });
});
