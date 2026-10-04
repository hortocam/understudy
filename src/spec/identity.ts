/**
 * Identity allocation (FR-011, data-model.md §"Identity allocation").
 *
 * A `string` identity whose field declares a `pattern` must be **a value satisfying that
 * pattern**; the bare stringified counter does not satisfy `^W-[0-9]{6}$`, so it is a
 * non-conforming identity — the mock differing from the real service in *shape*, which is the
 * failure this product exists to prevent.
 *
 * The pattern-to-value step is deliberately bounded, not a regex synthesiser: it covers the
 * shapes a real document declares for identities — a literal prefix/suffix around a run of
 * digits and/or letters, with a fixed quantifier (`docs/05-target-apis.md` §1 measures
 * `externalId`, `groupId`, `viagogoEventId`: prefixed and uuid-ish strings). Anything outside
 * that subset is refused, and the derivation reports an `identity-pattern-unsupported` ambiguity
 * rather than guessing (principle VI). Where the counter outgrows the declared digit width, the
 * numeric run wraps modulo the width so the value still conforms; the startup report prints the
 * pattern, so that bound is visible.
 */
import type { Resource } from "./types.js";

interface LiteralSlot {
  kind: "literal";
  text: string;
}
interface DigitSlot {
  kind: "digits";
  count: number;
}
interface LetterSlot {
  kind: "letters";
  count: number;
  letter: string;
}
type Slot = LiteralSlot | DigitSlot | LetterSlot;

interface Quantifier {
  count: number;
  end: number;
}

/** Read an optional quantifier at `index`; a bare atom is exactly one. */
function readQuantifier(pattern: string, index: number): Quantifier | undefined {
  const quantifier = pattern[index];
  if (quantifier === "{") {
    const close = pattern.indexOf("}", index);
    if (close === -1) return undefined;
    const match = /^(\d+)(?:,(\d+))?$/.exec(pattern.slice(index + 1, close));
    if (!match) return undefined;
    const count = Number(match[1]);
    if (count <= 0) return undefined;
    return { count, end: close + 1 };
  }
  if (quantifier === "+" || quantifier === "*" || quantifier === "?") return { count: 1, end: index + 1 };
  return { count: 1, end: index };
}

/** Parse the supported subset of a declared pattern into ordered slots, or undefined. */
export function parsePattern(pattern: string): Slot[] | undefined {
  let body = pattern;
  if (body.startsWith("^")) body = body.slice(1);
  if (body.endsWith("$")) body = body.slice(0, -1);

  const slots: Slot[] = [];
  let literal = "";
  const flush = (): void => {
    if (literal.length > 0) {
      slots.push({ kind: "literal", text: literal });
      literal = "";
    }
  };

  let index = 0;
  while (index < body.length) {
    const char = body[index] as string;

    if (char === "\\") {
      const escaped = body[index + 1];
      const quantifier = readQuantifier(body, index + 2);
      if (!quantifier || escaped === undefined) return undefined;
      if (escaped === "d") {
        flush();
        slots.push({ kind: "digits", count: quantifier.count });
        index = quantifier.end;
        continue;
      }
      if (escaped === "w") {
        flush();
        slots.push({ kind: "letters", count: quantifier.count, letter: "A" });
        index = quantifier.end;
        continue;
      }
      literal += escaped;
      index += 2;
      continue;
    }

    if (char === "[") {
      const close = body.indexOf("]", index + 1);
      if (close === -1) return undefined;
      const range = body.slice(index + 1, close);
      const quantifier = readQuantifier(body, close + 1);
      if (!quantifier) return undefined;
      if (/^0-9$|^\\d$/.test(range)) {
        flush();
        slots.push({ kind: "digits", count: quantifier.count });
      } else if (/^(a-z|A-Z|A-Za-z|a-zA-Z)$/.test(range)) {
        flush();
        slots.push({ kind: "letters", count: quantifier.count, letter: range.includes("a-z") ? "a" : "A" });
      } else {
        return undefined;
      }
      index = quantifier.end;
      continue;
    }

    // Constructs the bounded subset does not model: refuse rather than guess.
    if (".()|+?{}*$^".includes(char)) return undefined;
    literal += char;
    index += 1;
  }
  flush();
  return slots;
}

function totalDigits(slots: Slot[]): number {
  return slots.reduce((sum, slot) => (slot.kind === "digits" ? sum + slot.count : sum), 0);
}

function render(slots: Slot[], counter: number): string {
  const width = totalDigits(slots);
  let digits = "";
  if (width > 0) {
    const modulus = 10 ** Math.min(width, 15);
    digits = String(counter % modulus).padStart(width, "0");
    if (digits.length > width) digits = digits.slice(digits.length - width);
  }

  let cursor = 0;
  let out = "";
  for (const slot of slots) {
    if (slot.kind === "literal") out += slot.text;
    else if (slot.kind === "digits") {
      out += digits.slice(cursor, cursor + slot.count);
      cursor += slot.count;
    } else out += slot.letter.repeat(slot.count);
  }
  return out;
}

/**
 * True when `pattern` is inside the bounded subset the identity generator can satisfy. Used by
 * the derivation to report `identity-pattern-unsupported` rather than guess (principle VI).
 */
export function patternSupported(pattern: string): boolean {
  const slots = parsePattern(pattern);
  if (!slots) return false;
  const verify = new RegExp(`^(?:${pattern})$`);
  const renderer = (counter: number): string => render(slots, counter);
  return verify.test(renderer(100000)) && verify.test(renderer(100001));
}

/**
 * A renderer for one resource's identity, or undefined when the declared type/pattern is
 * outside the supported subset. The shape is checked at derivation time (a sample is verified
 * against the declared pattern), so an unsupported pattern is reported rather than producing a
 * non-conforming identity at request time.
 */
export function identityRenderer(resource: Resource): ((counter: number) => string) | undefined {
  if (resource.idType !== "string") return undefined;
  const pattern = resource.idPattern;
  if (pattern === undefined || !patternSupported(pattern)) return undefined;
  const slots = parsePattern(pattern) as Slot[];
  return (counter: number): string => render(slots, counter);
}

/**
 * Allocate an identity for `resource` at `counter`.
 *
 * - integer / untyped → the decimal counter (typed back to a number on read).
 * - string with a supported declared pattern → a value satisfying it (FR-011).
 * - string without a pattern → an opaque short id (base36 of the same reserved counter space,
 *   so it can never collide with a fixture-supplied range below `generatedStart`).
 */
export function allocateIdentity(resource: Resource, counter: number): string {
  if (resource.idType === "string") {
    const renderer = identityRenderer(resource);
    if (renderer) return renderer(counter);
    // Unsupported pattern: an opaque short id rather than an invalid one. The derivation
    // reports `identity-pattern-unsupported`, so the fallback is visible (FR-011, VI).
    return counter.toString(36);
  }
  return String(counter);
}
