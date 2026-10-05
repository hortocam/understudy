/**
 * The clock seam (FR-019, principle X).
 *
 * Every time-derived value in the tool — record timestamps, faker's relative-date methods —
 * is read through this interface, never `Date.now()`, so a seeded run is reproducible and the
 * mode in force can be reported. Only the real implementation exists; slice 6 adds a virtual
 * one behind the same interface.
 *
 * A run reads the clock **once** (`startRun`) so every record of one generation shares an
 * instant. With `clock.start` configured that instant is the configured one on every run; without
 * it the real instant differs between runs and the report says so (`clock-unpinned`).
 */
import { ReservedConfigError } from "./errors.js";

export interface RunClock {
  now(): Date;
}

export interface Clock {
  readonly mode: "real" | "virtual";
  /** True when `clock.start` pins the instant, so time-derived values are reproducible. */
  readonly pinned: boolean;
  now(): Date;
  /** Freeze the instant for one run: every later `now()` on the result is the same. */
  startRun(): RunClock;
}

export interface ClockOptions {
  mode?: "real" | "virtual";
  start?: string;
}

export function createClock(options: ClockOptions = {}): Clock {
  if (options.mode === "virtual") {
    throw new ReservedConfigError("clock.mode", 'the virtual clock is a later slice (6); only "real" is implemented');
  }
  const pinnedAt = options.start === undefined ? undefined : new Date(options.start);
  const now = (): Date => (pinnedAt ? new Date(pinnedAt.getTime()) : new Date());
  return {
    mode: "real",
    pinned: pinnedAt !== undefined,
    now,
    startRun(): RunClock {
      const instant = now().getTime();
      return { now: () => new Date(instant) };
    },
  };
}
