/**
 * The FR-010 precedence chain (constitution VII family 1), walked down all six levels by removing
 * one source at a time — the US7 independent test — with the rule that produced each value
 * recorded and asserted against a HAND-AUTHORED golden.
 *
 * Reading of FR-010 applied (the spec governs): an explicit rule in the recipe is level 1 whatever
 * its kind (the kind is recorded in `rule`); levels 2–6 apply to a field that has none.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chooseValue, isFallback, planField, type FieldInput } from "../../src/data/precedence.js";
import type { FixtureRows } from "../../src/data/fixtures.js";
import { fixturePath } from "../helpers/mock.js";
import { makeEnv } from "../helpers/env.js";

interface GoldenStep {
  step: string;
  level: number;
  rule: string;
}
const golden = JSON.parse(readFileSync(fixturePath("golden/precedence-chain.json"), "utf8")) as GoldenStep[];

const REFS = { values: (collection: string, field: string): unknown[] => (collection === "Status" && field === "id" ? [7] : []) };

const base = { collection: "Ticket", field: "contact" };
const fullSchema = { type: "string", format: "email", enum: ["only@enum.test"], example: "ex@example.test", default: "dflt@example.test" };

/** One input per step; each removes exactly the source the previous step used. */
const steps: Array<{ input: FieldInput; expected?: unknown }> = [
  { input: { ...base, schema: fullSchema, rule: { choice: ["from-rule"] }, supplied: { value: "from-supplied" }, link: { to: "Status", toField: "id" } }, expected: "from-rule" },
  { input: { ...base, schema: fullSchema, supplied: { value: "from-supplied" }, link: { to: "Status", toField: "id" } }, expected: "from-supplied" },
  { input: { ...base, schema: fullSchema, link: { to: "Status", toField: "id" } }, expected: 7 },
  { input: { ...base, schema: fullSchema }, expected: "only@enum.test" },
  { input: { ...base, schema: { type: "string", format: "email", example: "ex@example.test", default: "dflt@example.test" } }, expected: "ex@example.test" },
  { input: { ...base, schema: { type: "string", format: "email", default: "dflt@example.test" } }, expected: "dflt@example.test" },
  { input: { ...base, schema: { type: "string", format: "email" } } },
  { input: { ...base, field: "phone", schema: { type: "string" } } },
  { input: { ...base, field: "whatever", schema: {} }, expected: null },
];

describe("FR-010 precedence — value and provenance at every level", () => {
  it("has one golden step per input step (the golden is the spec's chain, not the code's)", () => {
    expect(golden).toHaveLength(steps.length);
    expect(golden.map((g) => g.level)).toEqual([1, 2, 3, 4, 4, 4, 5, 5, 6]);
  });

  it.each(golden.map((g, i) => [i, g.step, g] as const))("step %i — %s", async (index, _label, expectedStep) => {
    const { input, expected } = steps[index] as (typeof steps)[number];
    const env = await makeEnv({ refs: REFS });
    const chosen = await chooseValue(input, env, {});
    expect(chosen.provenance).toEqual({ level: expectedStep.level, rule: expectedStep.rule });
    if (expected !== undefined) expect(chosen.value).toBe(expected);
    // the static plan is the SAME decision, so the report can never disagree with the data (research §5)
    expect(planField(input)).toEqual(chosen.provenance);
  });

  it("heuristic values are plausible for the field, and flagged as a fallback so the report can say so (US7.4)", async () => {
    const env = await makeEnv();
    const email = await chooseValue({ ...base, schema: { type: "string", format: "email" } }, env, {});
    expect(email.value as string).toMatch(/^[^@\s]+@[^@\s]+\.[^@\s]+$/);
    const phone = await chooseValue({ ...base, field: "phone", schema: { type: "string" } }, env, {});
    expect(typeof phone.value).toBe("string");
    expect(isFallback(email.provenance)).toBe(true);
    expect(isFallback({ level: 4, rule: "enum" })).toBe(false);
    expect(isFallback({ level: 1, rule: "faker:string.alpha" })).toBe(false);
  });

  it("an explicit rule wins over a supplied value; a supplied value wins over a generator-free spec default (US7.1/7.2)", async () => {
    const env = await makeEnv();
    const schema = { type: "string", default: "from-spec" };
    const explicit = await chooseValue({ ...base, schema, rule: { choice: ["rule"] }, supplied: { value: "supplied" } }, env, {});
    expect(explicit.value).toBe("rule");
    const supplied = await chooseValue({ ...base, schema, supplied: { value: "supplied" } }, env, {});
    expect(supplied.value).toBe("supplied");
  });

  it("a field with a spec enum NEVER falls through to the heuristic: every draw is a member (FR-014)", async () => {
    const env = await makeEnv();
    const set = ["MA", "NY", "CA"];
    for (let i = 0; i < 200; i += 1) {
      const chosen = await chooseValue({ ...base, field: "state", schema: { type: "string", enum: set } }, env, {});
      expect(set).toContain(chosen.value);
      expect(chosen.provenance.level).toBe(4);
    }
  });

  it("an explicit rule of any kind records level 1 and its kind", async () => {
    const env = await makeEnv({
      refs: REFS,
      lookups: new Map<string, FixtureRows>([["S", { idField: "id", rows: [{ row: { id: 1, code: "a" }, file: "f" }] }]]),
    });
    const kinds: Array<[Record<string, unknown>, string]> = [
      [{ faker: "string.alpha", length: 1 }, "faker:string.alpha"],
      [{ lookup: "S" }, "lookup:S"],
      [{ ref: "Status.id" }, "ref:Status.id"],
      [{ seq: "n" }, "seq:n"],
      [{ choice: [1, 2] }, "choice"],
      [{ expr: "1 + 1" }, "expr"],
    ];
    for (const [rule, label] of kinds) {
      const chosen = await chooseValue({ ...base, schema: { type: "string" }, rule }, env, {});
      expect(chosen.provenance).toEqual({ level: 1, rule: label });
    }
  });
});
