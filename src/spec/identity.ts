/**
 * Identity allocation (FR-011, FR-017, FR-018, data-model.md §"Identity allocation").
 *
 * A `string` identity whose field declares a `pattern` must be **a value satisfying that
 * pattern**; the bare stringified counter does not satisfy `^W-[0-9]{6}$`, so it would be a
 * non-conforming identity — the mock differing from the real service in *shape*, which is the
 * failure this product exists to prevent.
 *
 * The pattern-to-value step is deliberately bounded, not a regex synthesiser: it covers the shapes
 * a real document declares for identities — a literal prefix/suffix around runs of digits and/or
 * letters (`docs/05-target-apis.md` §1 measures `externalId`, `groupId`, `viagogoEventId`).
 * Anything outside that subset is refused, and the derivation reports an
 * `identity-pattern-unsupported` ambiguity rather than guessing (principle VI).
 *
 * Quantifiers carry a minimum and a maximum. A fixed run (`{6}`) is exactly that wide; an OPEN
 * run (`+`, `*`, `{n,}`) grows with the counter, keeping its declared minimum width — so
 * `^W-[0-9]+$` yields W-7, W-100000, W-123456789 and never repeats (F-E: it used to be read as
 * exactly one digit, allocating W-0…W-9 and then colliding). A run that is out of room is a named
 * refusal (`IdentitySpaceExhaustedError`), never a silent wrap into a duplicate.
 *
 * The counter is carried by the digit runs; a pattern with no digit run carries it in its letter
 * runs (base 26, `A` = 0), so a letters-only pattern is unique too.
 */
import { createHash } from "node:crypto";
import { IdentitySpaceExhaustedError } from "../errors.js";
import type { Resource } from "./types.js";

interface LiteralSlot {
  kind: "literal";
  text: string;
}
interface RunSlot {
  kind: "digits" | "letters";
  min: number;
  /** Undefined = unbounded (an open quantifier). */
  max: number | undefined;
  /** The letter a letters run uses when it does not carry the counter. */
  letter: string;
}
type Slot = LiteralSlot | RunSlot;

interface Quantifier {
  min: number;
  max: number | undefined;
  end: number;
}

/** Read an optional quantifier at `index`; a bare atom is exactly one. */
function readQuantifier(pattern: string, index: number): Quantifier | undefined {
  const quantifier = pattern[index];
  if (quantifier === "{") {
    const close = pattern.indexOf("}", index);
    if (close === -1) return undefined;
    const match = /^(\d+)(,(\d*))?$/.exec(pattern.slice(index + 1, close));
    if (!match) return undefined;
    const min = Number(match[1]);
    const max = match[2] === undefined ? min : match[3] === "" ? undefined : Number(match[3]);
    if (max !== undefined && (max < min || max <= 0)) return undefined;
    if (max === undefined && min < 0) return undefined;
    return { min, max, end: close + 1 };
  }
  if (quantifier === "+") return { min: 1, max: undefined, end: index + 1 };
  if (quantifier === "*") return { min: 0, max: undefined, end: index + 1 };
  // `?` makes the run optional; an identity always includes it, which still matches the pattern.
  if (quantifier === "?") return { min: 1, max: 1, end: index + 1 };
  return { min: 1, max: 1, end: index };
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
      if (escaped === undefined) return undefined;
      if (escaped === "d" || escaped === "w") {
        const quantifier = readQuantifier(body, index + 2);
        if (!quantifier) return undefined;
        flush();
        slots.push({ kind: escaped === "d" ? "digits" : "letters", min: quantifier.min, max: quantifier.max, letter: "A" });
        index = quantifier.end;
        continue;
      }
      // A back-reference or any other class is outside the subset.
      if (/[0-9A-Za-z]/.test(escaped)) return undefined;
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
        slots.push({ kind: "digits", min: quantifier.min, max: quantifier.max, letter: "A" });
      } else if (/^(a-z|A-Z|A-Za-z|a-zA-Z)$/.test(range)) {
        flush();
        slots.push({ kind: "letters", min: quantifier.min, max: quantifier.max, letter: range.includes("a-z") && !range.startsWith("A") ? "a" : "A" });
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

const ZERO: Record<RunSlot["kind"], string> = { digits: "0", letters: "A" };

/** The counter as the text carried by the variable runs: decimal digits, or base-26 letters (A = 0). */
function encode(kind: RunSlot["kind"], counter: number, upper: boolean): string {
  if (kind === "digits") return String(counter);
  const letters = counter
    .toString(26)
    .split("")
    .map((c) => (c >= "0" && c <= "9" ? String.fromCharCode(65 + Number(c)) : String.fromCharCode(65 + 10 + (c.charCodeAt(0) - 97))))
    .join("");
  return upper ? letters : letters.toLowerCase();
}

function render(slots: Slot[], counter: number, who: { name: string; pattern: string }): string {
  const runs = slots.filter((s): s is RunSlot => s.kind !== "literal");
  const variableKind: RunSlot["kind"] | undefined = runs.some((r) => r.kind === "digits")
    ? "digits"
    : runs.some((r) => r.kind === "letters")
      ? "letters"
      : undefined;
  const exhausted = (): never => {
    throw new IdentitySpaceExhaustedError(who.name, who.pattern);
  };
  if (!variableKind) {
    if (counter !== 0) exhausted();
    return slots.map((s) => (s.kind === "literal" ? s.text : "")).join("");
  }

  const carriers = runs.filter((r) => r.kind === variableKind);
  const upper = carriers.every((r) => r.letter === "A");
  const minWidth = carriers.reduce((sum, r) => sum + r.min, 0);
  const capacity = carriers.some((r) => r.max === undefined) ? Infinity : carriers.reduce((sum, r) => sum + (r.max as number), 0);
  let text = encode(variableKind, counter, upper);
  if (text.length < minWidth) text = text.padStart(minWidth, upper ? ZERO[variableKind] : ZERO[variableKind].toLowerCase());
  if (text.length > capacity) exhausted();

  // Each carrier takes its minimum, then the surplus is handed out left to right up to its maximum.
  let surplus = text.length - minWidth;
  const widths = carriers.map((r) => {
    const take = Math.min(surplus, r.max === undefined ? surplus : r.max - r.min);
    surplus -= take;
    return r.min + take;
  });
  if (surplus > 0) exhausted();

  let cursor = 0;
  let carrier = 0;
  let out = "";
  for (const slot of slots) {
    if (slot.kind === "literal") out += slot.text;
    else if (slot.kind === variableKind) {
      const width = widths[carrier] as number;
      out += text.slice(cursor, cursor + width);
      cursor += width;
      carrier += 1;
    } else out += slot.letter.repeat(slot.min);
  }
  return out;
}

/**
 * True when `pattern` is inside the bounded subset the identity generator can satisfy: it parses,
 * renders conforming values, and distinct counters render distinct values. Used by the derivation
 * to report `identity-pattern-unsupported` rather than guess (principle VI).
 */
export function patternSupported(pattern: string): boolean {
  const slots = parsePattern(pattern);
  if (!slots) return false;
  let verify: RegExp;
  try {
    verify = new RegExp(`^(?:${pattern})$`);
  } catch {
    return false;
  }
  const who = { name: "(probe)", pattern };
  try {
    // Small counters, so a narrow fixed run (`{3}`) is not mistaken for an unsupported pattern.
    const a = render(slots, 1, who);
    const b = render(slots, 2, who);
    return verify.test(a) && verify.test(b) && a !== b;
  } catch {
    return false;
  }
}

/**
 * A renderer for one resource's identity, or undefined when the declared type/pattern is outside
 * the supported subset. The shape is checked at derivation time, so an unsupported pattern is
 * reported rather than producing a non-conforming identity at request time.
 */
export function identityRenderer(resource: Resource): ((counter: number) => string) | undefined {
  if (resource.idType !== "string") return undefined;
  const pattern = resource.idPattern;
  if (pattern === undefined || !patternSupported(pattern)) return undefined;
  const slots = parsePattern(pattern) as Slot[];
  const who = { name: resource.name, pattern };
  return (counter: number): string => render(slots, counter, who);
}

/**
 * The counter a rendered identity corresponds to, or undefined when it does not match the
 * resource's pattern or the pattern is unsupported. Used to ask "does this fixture lie inside the
 * generated range?" in a formatted identity space (FR-017).
 */
export function identityCounter(resource: Resource, identity: string): number | undefined {
  const pattern = resource.idPattern;
  if (resource.idType !== "string" || pattern === undefined || !patternSupported(pattern)) return undefined;
  const slots = parsePattern(pattern) as Slot[];
  const runs = slots.filter((s): s is RunSlot => s.kind !== "literal");
  const variableKind = runs.some((r) => r.kind === "digits") ? "digits" : runs.some((r) => r.kind === "letters") ? "letters" : undefined;
  if (!variableKind) return undefined;
  const classOf = (r: RunSlot): string => (r.kind === "digits" ? "[0-9]" : r.letter === "A" ? "[A-Z]" : "[a-z]");
  const source = slots
    .map((s) => {
      if (s.kind === "literal") return s.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const quantifier = s.max === s.min ? `{${s.min}}` : s.max === undefined ? `{${s.min},}` : `{${s.min},${s.max}}`;
      return s.kind === variableKind ? `(${classOf(s)}${quantifier})` : `${classOf(s)}${quantifier}`;
    })
    .join("");
  const match = new RegExp(`^${source}$`).exec(identity);
  if (!match) return undefined;
  const text = match.slice(1).join("");
  if (variableKind === "digits") {
    const n = Number(text);
    return Number.isSafeInteger(n) ? n : undefined;
  }
  const upper = text === text.toUpperCase();
  let value = 0;
  for (const ch of upper ? text : text.toUpperCase()) value = value * 26 + (ch.charCodeAt(0) - 65);
  return Number.isSafeInteger(value) ? value : undefined;
}

/** A v4-shaped uuid derived from `(scope, counter)`: deterministic, so runtime allocation is reproducible. */
export function deterministicUuid(scope: string, counter: number): string {
  const hex = createHash("sha256").update(`${scope}\u0000${counter}`).digest("hex");
  const variant = ((Number.parseInt(hex[16] as string, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Allocate an identity for `resource` at `counter`.
 *
 * - integer / untyped → the decimal counter (typed back to a number on read).
 * - string with a supported declared pattern → a value satisfying it (FR-011).
 * - string with `format: uuid` → a deterministic v4-shaped uuid of the counter (the bare counter
 *   would not be a uuid, and a base-36 id would violate the declared format).
 * - any other string → an opaque short id (base 36 of the same reserved counter space).
 */
export function allocateIdentity(resource: Resource, counter: number): string {
  if (resource.idType === "string") {
    const renderer = identityRenderer(resource);
    if (renderer) return renderer(counter);
    if (resource.idSpace === "uuid") return deterministicUuid(resource.name, counter);
    // Unsupported pattern: an opaque short id rather than an invalid one. The derivation
    // reports `identity-pattern-unsupported`, so the fallback is visible (FR-011, VI).
    return counter.toString(36);
  }
  return String(counter);
}


/** A stored identity (text) typed back to the form the document declares: a number for an integer identity. */
export function typedIdentityValue(resource: Pick<Resource, "idType">, identity: string): string | number {
  if (resource.idType === "integer") {
    const value = Number.parseInt(identity, 10);
    return Number.isNaN(value) ? identity : value;
  }
  return identity;
}
