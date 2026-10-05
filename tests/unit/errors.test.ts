import { describe, expect, it } from "vitest";
import {
  ConfigContradictsSpecError,
  ConfigInvalidError,
  ConfigLayerInvalidError,
  ConfigReferenceError,
  ConfigRefusedError,
  FixtureConformanceError,
  GenerationMarkerMismatchError,
  GenerationRefusedError,
  IdentityRangeOverlapError,
  IdentitySpaceExhaustedError,
  InvariantViolatedError,
  RecipeNotFoundError,
  UnknownGeneratorError,
  ConfigUnparseableError,
  EmptySelectionError,
  ReservedConfigError,
  SpecInvalidError,
  SpecUnreadableError,
  StoreUnwritableError,
  UnderstudyError,
  UnknownOperationError,
} from "../../src/errors.js";

describe("error taxonomy", () => {
  const cases: Array<{ error: UnderstudyError; value: string; code: string }> = [
    { error: new SpecUnreadableError("/no/such/spec.yaml", "ENOENT"), value: "/no/such/spec.yaml", code: "SPEC_UNREADABLE" },
    { error: new SpecInvalidError("https://example.test/spec.yaml", "bad ref"), value: "https://example.test/spec.yaml", code: "SPEC_INVALID" },
    { error: new ConfigUnparseableError("understudy.yaml", "bad yaml"), value: "understudy.yaml", code: "CONFIG_UNPARSEABLE" },
    { error: new ConfigInvalidError("bogus", "unknown key"), value: "bogus", code: "CONFIG_INVALID" },
    { error: new EmptySelectionError([]), value: "[]", code: "EMPTY_SELECTION" },
    { error: new UnknownOperationError("GET /nope"), value: "GET /nope", code: "UNKNOWN_OPERATION" },
    { error: new StoreUnwritableError("./state.db", "EACCES"), value: "./state.db", code: "STORE_UNWRITABLE" },
    { error: new ReservedConfigError("signing", "later slice"), value: "signing", code: "RESERVED_CONFIG" },
    { error: new ConfigLayerInvalidError("dynamic", "dynamic/ci.yaml", "entities.Inventory.bogus", "unknown key"), value: "entities.Inventory.bogus", code: "CONFIG_LAYER_INVALID" },
    { error: new ConfigReferenceError("dynamic/ci.yaml", "entities.Ghost", "no collection named Ghost"), value: "entities.Ghost", code: "CONFIG_REFERENCE" },
    { error: new ConfigContradictsSpecError("static/venues.yaml", "rows[0].state", "must be a string"), value: "rows[0].state", code: "CONFIG_CONTRADICTS_SPEC" },
    { error: new IdentityRangeOverlapError("Inventory", "fixture id 100001 lies inside the generated span"), value: "Inventory", code: "IDENTITY_RANGE_OVERLAP" },
    { error: new IdentitySpaceExhaustedError("Widget", "^W-[0-9]{2}$"), value: "Widget", code: "IDENTITY_SPACE_EXHAUSTED" },
    { error: new InvariantViolatedError("Inventory", "price >= cost", 50), value: "price >= cost", code: "INVARIANT_VIOLATED" },
    { error: new UnknownGeneratorError("dynamic/ci.yaml", "entities.X.fields.y", "sectionCod"), value: "sectionCod", code: "UNKNOWN_GENERATOR" },
    { error: new RecipeNotFoundError("ci-smal", ["ci-small", "load-test"]), value: "ci-smal", code: "RECIPE_NOT_FOUND" },
    { error: new GenerationMarkerMismatchError("recipe", "ci-small", "load-test"), value: "recipe", code: "GENERATION_MARKER_MISMATCH" },
    { error: new FixtureConformanceError("static/venues.yaml", "Venue", "1", "rows[0].name", "must be string"), value: "static/venues.yaml", code: "FIXTURE_NONCONFORMING" },
    { error: new GenerationRefusedError("Inventory", "eventId", "the parent collection Event has no records"), value: "Inventory", code: "GENERATION_REFUSED" },
    { error: new ConfigRefusedError([{ file: "a.yaml", key: "k1", cause: "bad" }, { file: "b.yaml", key: "k2", cause: "worse" }]), value: "k1", code: "CONFIG_REFUSED" },
  ];

  it.each(cases)("$code names its offending value", ({ error, value, code }) => {
    expect(error).toBeInstanceOf(UnderstudyError);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(value);
    expect(error.code).toBe(code);
    expect(error.value).toBeDefined();
  });

  it("serialises to JSON with the offending value", () => {
    const error = new UnknownOperationError("GET /nope");
    expect(error.toJSON()).toEqual({
      code: "UNKNOWN_OPERATION",
      name: "UnknownOperationError",
      message: expect.stringContaining("GET /nope"),
      value: "GET /nope",
    });
  });
});

describe("refusals read as `file: key — cause` (FR-005, Scenario 7)", () => {
  it("a layer error names the layer file and the key in one shape", () => {
    const error = new ConfigLayerInvalidError("behavior", "behavior/webhooks.yaml", "targets.pos.bogus", "unknown key");
    expect(error.message).toContain("behavior/webhooks.yaml: targets.pos.bogus");
  });

  it("an aggregate lists every cause, so one run reports all of them", () => {
    const error = new ConfigRefusedError([
      { file: "a.yaml", key: "k1", cause: "bad" },
      { file: "b.yaml", key: "k2", cause: "worse" },
    ]);
    expect(error.message).toContain("a.yaml: k1");
    expect(error.message).toContain("b.yaml: k2");
    expect(error.refusals).toHaveLength(2);
  });

  it("an invariant failure names the collection, the rule text and the budget", () => {
    const error = new InvariantViolatedError("Inventory", "price >= cost", 50);
    expect(error.message).toMatch(/Inventory/);
    expect(error.message).toMatch(/price >= cost/);
    expect(error.message).toMatch(/50/);
  });
});
