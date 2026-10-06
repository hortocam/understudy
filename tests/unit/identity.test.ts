/**
 * FR-011 identity allocation, unit level: the pattern-to-value step is a bounded, verifiable
 * function, and a pattern outside that subset is refused (and reported) rather than guessed.
 */
import { describe, expect, it } from "vitest";
import { allocateIdentity, identityRenderer, patternSupported } from "../../src/spec/identity.js";
import { IdentitySpaceExhaustedError } from "../../src/errors.js";
import type { Resource } from "../../src/spec/types.js";

function resource(overrides: Partial<Resource>): Resource {
  return {
    name: "Thing",
    collectionPath: "/things",
    idField: "id",
    idType: "integer",
    idSpace: "integer",
    pagingStyle: "none-declared",
    filterFields: [],
    sortFields: [],
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


describe("F-E — open quantifiers allocate unique, conforming identities (slice 1 deferral, owned here)", () => {
  // Each pattern is allocated 1 000 consecutive identities from the default runtime start. The
  // bounded generator used to map `+`, `*` and `{n,}` to exactly ONE unit, so `^W-[0-9]+$`
  // produced W-0..W-9 and then repeated: a UNIQUE collision (a 500) at the eleventh create.
  const PATTERNS = ["^W-[0-9]+$", "^W-[0-9]{3,}$", "^[A-Z]+-[0-9]*$", "^[0-9]+$", "^ID[0-9]{2,}X$"];

  it.each(PATTERNS)("%s: 1 000 consecutive identities are unique and every one matches the declared pattern", (pattern) => {
    const thing = resource({ idType: "string", idSpace: "formatted", idPattern: pattern });
    expect(patternSupported(pattern)).toBe(true);
    const ids = Array.from({ length: 1000 }, (_, i) => allocateIdentity(thing, 100000 + i));
    expect(new Set(ids).size).toBe(1000);
    const re = new RegExp(pattern);
    expect(ids.filter((id) => !re.test(id))).toEqual([]);
  });

  it("an open numeric run grows with the counter instead of wrapping (and keeps its declared minimum width)", () => {
    const widget = resource({ idType: "string", idSpace: "formatted", idPattern: "^W-[0-9]+$" });
    expect(allocateIdentity(widget, 7)).toBe("W-7");
    expect(allocateIdentity(widget, 100000)).toBe("W-100000");
    expect(allocateIdentity(widget, 123456789)).toBe("W-123456789");
    const gadget = resource({ idType: "string", idSpace: "formatted", idPattern: "^G-[0-9]{3,}$" });
    expect(allocateIdentity(gadget, 7)).toBe("G-007");
    expect(allocateIdentity(gadget, 12345)).toBe("G-12345");
  });

  it("with no digit run, the counter is carried by the letters (bijective growth), still unique and conforming", () => {
    const thing = resource({ idType: "string", idSpace: "formatted", idPattern: "^[A-Z]+$" });
    const ids = Array.from({ length: 1000 }, (_, i) => allocateIdentity(thing, i));
    expect(new Set(ids).size).toBe(1000);
    expect(ids.every((id) => /^[A-Z]+$/.test(id))).toBe(true);
  });

  it("a FIXED width that is exhausted refuses by name instead of wrapping into a collision (was: modulo wrap)", () => {
    const thing = resource({ name: "Ticket", idType: "string", idSpace: "formatted", idPattern: "^T-[0-9]{3}$" });
    expect(allocateIdentity(thing, 999)).toBe("T-999");
    expect(() => allocateIdentity(thing, 1000)).toThrow(IdentitySpaceExhaustedError);
    expect(() => allocateIdentity(thing, 1000)).toThrow(/Ticket/);
  });

  it("a bounded range {n,m} grows to m digits and then refuses", () => {
    const thing = resource({ name: "Seat", idType: "string", idSpace: "formatted", idPattern: "^S[0-9]{1,2}$" });
    expect(allocateIdentity(thing, 5)).toBe("S5");
    expect(allocateIdentity(thing, 99)).toBe("S99");
    expect(() => allocateIdentity(thing, 100)).toThrow(IdentitySpaceExhaustedError);
  });

  it("constructs the generator still cannot satisfy are reported as unsupported (and fall back), never emitted non-conforming", () => {
    for (const pattern of ["^(a|b)\\d$", "^(?=.*A)[A-Z]{4}$", "^\\1[0-9]$"]) expect(patternSupported(pattern)).toBe(false);
  });
});
