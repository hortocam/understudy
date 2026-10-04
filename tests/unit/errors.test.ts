import { describe, expect, it } from "vitest";
import {
  ConfigInvalidError,
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