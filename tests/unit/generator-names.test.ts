import { describe, expect, it } from "vitest";
import { BUILTIN_GENERATOR_NAMES, isFakerPath } from "../../src/data/generators/names.js";

describe("the generator namespace", () => {
  it("recognises real faker methods and refuses everything else", () => {
    expect(isFakerPath("string.alpha")).toBe(true);
    expect(isFakerPath("finance.amount")).toBe(true);
    expect(isFakerPath("no.such")).toBe(false);
    expect(isFakerPath("string")).toBe(false);
    expect(isFakerPath("a.b.c")).toBe(false);
    expect(isFakerPath("constructor.name")).toBe(false);
  });

  it("never lets configuration reach the template-evaluating helpers", () => {
    expect(isFakerPath("helpers.fake")).toBe(false);
    expect(isFakerPath("helpers.mustache")).toBe(false);
  });

  it("names the built-in categories (names, codes, amounts, dates, quantities)", () => {
    for (const name of ["name", "code", "amount", "date", "quantity"]) expect(BUILTIN_GENERATOR_NAMES.has(name)).toBe(true);
  });
});
