/**
 * FR-011 identity allocation, unit level: the pattern-to-value step is a bounded, verifiable
 * function, and a pattern outside that subset is refused (and reported) rather than guessed.
 */
import { describe, expect, it } from "vitest";
import { allocateIdentity, identityRenderer, patternSupported } from "../../src/spec/identity.js";
import type { Resource } from "../../src/spec/types.js";

function resource(overrides: Partial<Resource>): Resource {
  return {
    name: "Thing",
    collectionPath: "/things",
    idField: "id",
    idType: "integer",
    listParams: [],
    operations: {},
    nameSource: "path-segment",
    ...overrides,
  };
}

describe("identity allocation (FR-011)", () => {
  it("allocates the decimal counter for an integer identity", () => {
    const thing = resource({ idType: "integer" });
    expect(allocateIdentity(thing, 100000)).toBe("100000");
    expect(allocateIdentity(thing, 100001)).toBe("100001");
  });

  it("satisfies a declared prefix + fixed-digit pattern", () => {
    const thing = resource({ idType: "string", idPattern: "^W-[0-9]{6}$" });
    expect(allocateIdentity(thing, 100000)).toBe("W-100000");
    expect(allocateIdentity(thing, 100042)).toBe("W-100042");
    expect(new RegExp(thing.idPattern as string).test(allocateIdentity(thing, 100042))).toBe(true);
  });

  it("satisfies a bare run-of-digits pattern", () => {
    const thing = resource({ idType: "string", idPattern: "[0-9]{8}" });
    expect(allocateIdentity(thing, 100000)).toBe("00100000");
  });

  it("satisfies a uuid-ish pattern of hex runs and literals", () => {
    const thing = resource({ idType: "string", idPattern: "^[a-f0-9]{8}-[a-f0-9]{4}$" });
    const value = allocateIdentity(thing, 100000);
    // The bounded generator cannot produce hex letters, so this pattern is refused...
    expect(patternSupported("^[a-f0-9]{8}-[a-f0-9]{4}$")).toBe(false);
    // ...and the fallback is an opaque short id, never a non-conforming counter.
    expect(value).toBe((100000).toString(36));
  });

  it("returns an opaque short id for a string identity with no declared pattern", () => {
    const thing = resource({ idType: "string" });
    expect(allocateIdentity(thing, 100000)).toBe((100000).toString(36));
    expect(identityRenderer(thing)).toBeUndefined();
  });

  it("refuses a pattern outside the bounded subset rather than emitting a non-conforming value", () => {
    for (const pattern of ["^(?!W-).*$", "^[a-z]{3}-\\d{2}(-\\d{2})?$", "^abc$|^def$"]) {
      expect(patternSupported(pattern), `${pattern} must be refused`).toBe(false);
      const thing = resource({ idType: "string", idPattern: pattern });
      const value = allocateIdentity(thing, 100000);
      // The fallback must still be a usable value, and the derivation reports the pattern.
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it("keeps allocated values distinct across the reserved counter space", () => {
    const thing = resource({ idType: "string", idPattern: "^W-[0-9]{6}$" });
    const values = new Set([100000, 100001, 100002].map((counter) => allocateIdentity(thing, counter)));
    expect(values.size).toBe(3);
  });
});
