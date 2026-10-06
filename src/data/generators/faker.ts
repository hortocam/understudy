/**
 * A faker rule: `faker: "string.alpha"` plus the method's options (FR-011, precedence level 5 when
 * it is the unruled heuristic; an explicit `faker:` rule is level 1 — FR-010). The path was
 * validated at load (`isFakerPath`), so an unknown one here is a bug, and still refuses by name.
 */
import type { Faker } from "@faker-js/faker";
import { isFakerPath } from "./names.js";

export function runFaker(faker: Faker, path: string, args: Record<string, unknown>): unknown {
  if (!isFakerPath(path)) throw new Error(`"${path}" is not a faker method`);
  const [moduleName, method] = path.split(".") as [string, string];
  const holder = (faker as unknown as Record<string, Record<string, (...a: unknown[]) => unknown>>)[moduleName] as Record<
    string,
    (...a: unknown[]) => unknown
  >;
  const options = Object.fromEntries(Object.entries(args).filter(([key]) => key !== "faker"));
  const fn = holder[method] as (...a: unknown[]) => unknown;
  return Object.keys(options).length > 0 ? fn.call(holder, options) : fn.call(holder);
}
