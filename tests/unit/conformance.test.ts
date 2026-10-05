/**
 * FR-014 / SC-004 — every value the tool produces conforms to the document's schema for that
 * field: allowed-value sets, formats, ranges and lengths. Property-style over a schema that
 * exercises each constraint family, 2 000 seeded draws, judged by the document's own Ajv
 * validator (never the generator's opinion).
 */
import { describe, expect, it } from "vitest";
import { generateRecord } from "../../src/data/record.js";
import { GenerationRefusedError } from "../../src/errors.js";
import { conformanceErrors } from "../../src/spec/conform.js";
import { makeEnv, resourceOf } from "../helpers/env.js";

const properties = {
  state: { type: "string", enum: ["MA", "NY", "CA"] },
  qty: { type: "integer", minimum: 3, maximum: 9 },
  qtyEx: { type: "integer", exclusiveMinimum: 0, exclusiveMaximum: 3 },
  price: { type: "number", minimum: 0.5, maximum: 99.5, multipleOf: 0.5 },
  rate: { type: "number", minimum: 0, maximum: 1 },
  short: { type: "string", minLength: 2, maxLength: 4 },
  long: { type: "string", minLength: 20, maxLength: 24 },
  code: { type: "string", pattern: "^[A-Z]{2}-[0-9]{4}$" },
  digits: { type: "string", pattern: "\\d{3}-\\d{2}" },
  when: { type: "string", format: "date-time" },
  day: { type: "string", format: "date" },
  clock: { type: "string", format: "time" },
  uid: { type: "string", format: "uuid" },
  contactEmail: { type: "string", format: "email" },
  site: { type: "string", format: "uri" },
  host: { type: "string", format: "hostname" },
  ip: { type: "string", format: "ipv4" },
  flag: { type: "boolean" },
  tags: { type: "array", items: { type: "integer", minimum: 1, maximum: 5 }, minItems: 2, maxItems: 4 },
  nested: {
    type: "object",
    required: ["a"],
    properties: { a: { type: "string", maxLength: 6 }, b: { type: "integer", minimum: 10, maximum: 12 } },
  },
  maybe: { type: ["string", "null"], maxLength: 5 },
  either: { oneOf: [{ type: "integer", minimum: 1, maximum: 3 }, { type: "string" }] },
  merged: { allOf: [{ type: "object", properties: { x: { type: "integer", maximum: 5 } } }, { type: "object", properties: { y: { type: "string", maxLength: 3 } } }] },
  withDefault: { type: "integer", default: 17, minimum: 10 },
  withConst: { const: "fixed" },
};

describe("every generated record conforms to the document's schema (FR-014, SC-004)", () => {
  it("2 000 seeded records over every constraint family all validate", async () => {
    const resource = resourceOf("Widget", properties, Object.keys(properties));
    const env = await makeEnv({ collection: "Widget" });
    const failures: string[] = [];
    let redraws = 0;
    for (let i = 1; i <= 2000; i += 1) {
      const { record, redraws: spent } = await generateRecord({ resource }, env, i);
      redraws += spent;
      const errors = conformanceErrors(resource, record);
      if (errors.length > 0) failures.push(`#${i}: ${errors.join("; ")}`);
      if (failures.length > 5) break;
    }
    expect(failures).toEqual([]);
    // conformance is by construction, not by luck: the redraw safety net is almost never used
    expect(redraws).toBeLessThan(20);
  });

  it("covers the value space: enums hit every member, ranges hit both ends, lengths vary", async () => {
    const resource = resourceOf("Widget", properties, Object.keys(properties));
    const env = await makeEnv({ collection: "Widget" });
    const rows = [] as Array<Record<string, unknown>>;
    for (let i = 1; i <= 600; i += 1) rows.push((await generateRecord({ resource }, env, i)).record);
    expect(new Set(rows.map((r) => r.state))).toEqual(new Set(["MA", "NY", "CA"]));
    const qty = rows.map((r) => r.qty as number);
    expect(Math.min(...qty)).toBe(3);
    expect(Math.max(...qty)).toBe(9);
    expect(new Set(rows.map((r) => (r.short as string).length)).size).toBeGreaterThan(1);
    expect(rows.every((r) => r.withConst === "fixed")).toBe(true);
  });

  it("a schema the generator cannot satisfy refuses, naming the collection and field — never a non-conforming record", async () => {
    const resource = resourceOf("Broken", { impossible: { type: "string", minLength: 10, maxLength: 5 } }, ["impossible"]);
    const env = await makeEnv({ collection: "Broken" });
    const error = await generateRecord({ resource }, env, 1).catch((e) => e as Error);
    expect(error).toBeInstanceOf(GenerationRefusedError);
    expect((error as Error).message).toContain("Broken");
    expect((error as Error).message).toContain("impossible");
  });

  it("a pattern outside the supported subset refuses by name rather than loosening the constraint", async () => {
    const resource = resourceOf("Odd", { weird: { type: "string", pattern: "^(?=.*[A-Z])(?=.*\\d).{8}$" } }, ["weird"]);
    const env = await makeEnv({ collection: "Odd" });
    const error = await generateRecord({ resource }, env, 1).catch((e) => e as Error);
    expect(error).toBeInstanceOf(GenerationRefusedError);
    expect((error as Error).message).toContain("weird");
  });
});
