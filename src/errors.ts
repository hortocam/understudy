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
  | "STORE_UNWRITABLE"
  | "RESERVED_CONFIG";

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