/**
 * The error taxonomy.
 *
 * One class per refusal cause the spec names. Every error carries the offending
 * value (`value`) and its message names it, so a refusal can be read by a human
 * without reading source code (FR-004, FR-021, FR-024, constitution VI).
 *
 * `code` is stable and machine-readable; `message` is for humans; `value` is the
 * raw thing that was wrong.
 */

export type ErrorCode =
  | "SPEC_UNREADABLE"
  | "SPEC_INVALID"
  | "CONFIG_UNPARSEABLE"
  | "CONFIG_INVALID"
  | "EMPTY_SELECTION"
  | "UNKNOWN_OPERATION"
  | "AMBIGUOUS_SELECTION"
  | "STORE_UNWRITABLE"
  | "RESERVED_CONFIG"
  | "CONFIG_LAYER_INVALID"
  | "CONFIG_REFERENCE"
  | "CONFIG_CONTRADICTS_SPEC"
  | "CONFIG_REFUSED"
  | "IDENTITY_RANGE_OVERLAP"
  | "IDENTITY_SPACE_EXHAUSTED"
  | "INVARIANT_VIOLATED"
  | "UNKNOWN_GENERATOR"
  | "RECIPE_NOT_FOUND"
  | "GENERATION_MARKER_MISMATCH"
  | "FIXTURE_NONCONFORMING"
  | "GENERATION_REFUSED"
  | "STORE_SCHEMA_CONFLICT";

function describe(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Base class for every refusal this tool raises. */
export class UnderstudyError extends Error {
  readonly code: ErrorCode;
  readonly value: unknown;

  constructor(code: ErrorCode, message: string, value: unknown) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.value = value;
  }

  toJSON(): { code: ErrorCode; name: string; message: string; value: unknown } {
    return { code: this.code, name: this.name, message: this.message, value: this.value };
  }
}

/** The document could not be read at all (missing file, failed fetch). */
export class SpecUnreadableError extends UnderstudyError {
  constructor(value: unknown, detail: string) {
    super("SPEC_UNREADABLE", `cannot read the OpenAPI document at ${describe(value)}: ${detail}`, value);
  }
}

/** The document was read but could not be parsed, upgraded or dereferenced. */
export class SpecInvalidError extends UnderstudyError {
  constructor(value: unknown, detail: string) {
    super("SPEC_INVALID", `the OpenAPI document ${describe(value)} is not usable: ${detail}`, value);
  }
}

/** The config file could not be read or parsed as YAML/JSON. */
export class ConfigUnparseableError extends UnderstudyError {
  constructor(value: unknown, detail: string) {
    super("CONFIG_UNPARSEABLE", `cannot parse the config file ${describe(value)}: ${detail}`, value);
  }
}

/** The config parsed but violates the config contract. */
export class ConfigInvalidError extends UnderstudyError {
  constructor(value: unknown, detail: string) {
    super("CONFIG_INVALID", `invalid config: ${detail} (offending value: ${describe(value)})`, value);
  }
}

/** The operation selection is empty. */
export class EmptySelectionError extends UnderstudyError {
  constructor(value: unknown) {
    super(
      "EMPTY_SELECTION",
      `the operation selection ${describe(value)} is empty: select at least one operation`,
      value,
    );
  }
}

/** The selection names an operation the document does not contain. */
export class UnknownOperationError extends UnderstudyError {
  constructor(value: unknown) {
    super(
      "UNKNOWN_OPERATION",
      `the operation selection names an operation the document does not contain: ${describe(value)}`,
      value,
    );
  }
}

/** The configured store location could not be opened for writing. */
export class StoreUnwritableError extends UnderstudyError {
  constructor(value: unknown, detail: string) {
    super("STORE_UNWRITABLE", `the store location ${describe(value)} is not writable: ${detail}`, value);
  }
}

/** A reserved config key was selected; the feature it names is not implemented yet. */
export class ReservedConfigError extends UnderstudyError {
  constructor(value: unknown, detail: string) {
    super("RESERVED_CONFIG", `the config key ${describe(value)} is reserved: ${detail}`, value);
  }
}

/** A configuration-layer file is invalid: one message shape for every layer (FR-005, Scenario 7). */
export class ConfigLayerInvalidError extends UnderstudyError {
  readonly layer: string;
  constructor(layer: string, file: string, key: string, detail: string) {
    super("CONFIG_LAYER_INVALID", `${file}: ${key} — ${detail} (${layer} layer)`, key);
    this.layer = layer;
  }
}

/** A configuration key refers to a collection, field or table that does not exist. */
export class ConfigReferenceError extends UnderstudyError {
  constructor(file: string, key: string, detail: string) {
    super("CONFIG_REFERENCE", `${file}: ${key} — ${detail}`, key);
  }
}

/** A configuration value contradicts the specification (constitution I). */
export class ConfigContradictsSpecError extends UnderstudyError {
  constructor(file: string, key: string, detail: string) {
    super("CONFIG_CONTRADICTS_SPEC", `${file}: ${key} — contradicts the specification: ${detail}`, key);
  }
}

export interface Refusal {
  file: string;
  key: string;
  cause: string;
}

/** Several configuration refusals found in one pass, so a run reports every cause (FR-005). */
export class ConfigRefusedError extends UnderstudyError {
  readonly refusals: Refusal[];
  constructor(refusals: Refusal[]) {
    const lines = refusals.map((r) => `  ${r.file}: ${r.key} — ${r.cause}`);
    super(
      "CONFIG_REFUSED",
      `${refusals.length} configuration ${refusals.length === 1 ? "problem" : "problems"}:\n${lines.join("\n")}`,
      refusals[0]?.key,
    );
    this.refusals = refusals;
  }
}

/** Configured identity ranges, or a fixture identity and a generated range, overlap (FR-017). */
export class IdentityRangeOverlapError extends UnderstudyError {
  constructor(collection: string, detail: string) {
    super("IDENTITY_RANGE_OVERLAP", `identity ranges overlap in collection ${collection}: ${detail}`, collection);
  }
}

/** A declared identity pattern ran out of values (never wrapped into a collision). */
export class IdentitySpaceExhaustedError extends UnderstudyError {
  constructor(collection: string, pattern: string) {
    super(
      "IDENTITY_SPACE_EXHAUSTED",
      `the identity space of ${collection} (pattern ${pattern}) is exhausted: no further conforming identity exists`,
      collection,
    );
  }
}

/** An invariant could not be satisfied within its redraw budget (FR-013). */
export class InvariantViolatedError extends UnderstudyError {
  readonly collection: string;
  constructor(collection: string, rule: string, budget: number) {
    super(
      "INVARIANT_VIOLATED",
      `collection ${collection}: the invariant "${rule}" could not be satisfied within ${budget} redraws; nothing was stored`,
      rule,
    );
    this.collection = collection;
  }
}

/** A field rule names a generator that is neither built in nor declared. */
export class UnknownGeneratorError extends UnderstudyError {
  constructor(file: string, key: string, generator: string) {
    super("UNKNOWN_GENERATOR", `${file}: ${key} — no generator named "${generator}" (built-in or declared)`, generator);
  }
}

/** The selected recipe does not exist. */
export class RecipeNotFoundError extends UnderstudyError {
  readonly available: string[];
  constructor(name: string, available: string[]) {
    super(
      "RECIPE_NOT_FOUND",
      `no recipe named ${name}; available: ${available.length > 0 ? available.join(", ") : "(none)"}`,
      name,
    );
    this.available = available;
  }
}

/** The store holds generated records from a different recipe, seed or configuration (D7). */
export class GenerationMarkerMismatchError extends UnderstudyError {
  constructor(what: string, stored: string, requested: string) {
    super(
      "GENERATION_MARKER_MISMATCH",
      `the store already holds generated records with ${what} "${stored}", not "${requested}"; run \`ustdy reset --to wipe\` first`,
      what,
    );
  }
}

/** A fixture row does not conform to the document's schema (FR-005, FR-014). */
export class FixtureConformanceError extends UnderstudyError {
  constructor(file: string, entity: string, identity: string, key: string, detail: string) {
    super("FIXTURE_NONCONFORMING", `${file}: ${key} — fixture ${entity} ${identity} does not conform to the specification: ${detail}`, file);
  }
}

/** Generation cannot proceed, with a named collection and cause. */
export class GenerationRefusedError extends UnderstudyError {
  constructor(collection: string, field: string, detail: string) {
    super("GENERATION_REFUSED", `collection ${collection}, field ${field}: ${detail}`, collection);
  }
}


/** A selection entry matches more than one selector form, or more than one tag (FR-002). */
export class AmbiguousSelectionError extends UnderstudyError {
  constructor(entry: string, matches: string[]) {
    super(
      "AMBIGUOUS_SELECTION",
      `the operation selection entry ${describe(entry)} is ambiguous: it matches ${matches.join(" and ")}; spell it unambiguously`,
      entry,
    );
  }
}


/** A store table cannot take a newly decided constraint because existing rows violate it. */
export class StoreSchemaConflictError extends UnderstudyError {
  constructor(resource: string, detail: string) {
    super("STORE_SCHEMA_CONFLICT", `cannot change the stored shape of ${resource}: ${detail}`, resource);
  }
}
