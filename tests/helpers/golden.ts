import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { expect } from "vitest";
import { fixturePath } from "./mock.js";

/**
 * Compare `actual` with the checked-in golden `tests/fixtures/golden/<name>.json`.
 *
 * The inference and precedence goldens are authored by hand from the spec. A *generator value
 * vector* cannot be: it is a regression vector — a fixed seed's output, captured once, reviewed
 * for plausibility and conformance, and checked in so a library upgrade or a refactor that
 * silently changes reproducible data fails loudly. Re-capture only deliberately:
 * `UPDATE_GOLDEN=1 npx vitest run <file>` and review the diff like any other.
 */
export function expectGolden(name: string, actual: unknown): void {
  const path = fixturePath(`golden/${name}.json`);
  const text = `${JSON.stringify(actual, null, 2)}\n`;
  if (process.env.UPDATE_GOLDEN === "1") {
    writeFileSync(path, text);
    return;
  }
  if (!existsSync(path)) throw new Error(`golden ${name}.json is missing; capture it deliberately with UPDATE_GOLDEN=1 and review it`);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(JSON.parse(text));
}
