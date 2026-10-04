/**
 * Request validation against the document's own schemas (FR-008).
 *
 * One Ajv validator is compiled per operation from the dereferenced document, so a request
 * is judged against the same shape a real client of the documented service would be held
 * to. Draft 2020-12 is what `@scalar/openapi-parser` normalises 3.1 to and what the
 * upgrader's 3.0 output is read as.
 *
 * Two Ajv instances, deliberately: a JSON *body* is validated strictly (a string where the
 * document declares an integer is a violation, not a value to coerce), while a *parameter*
 * is always delivered as a string by HTTP and must be coerced back to the declared type
 * before it can be judged.
 */
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsDefault from "ajv-formats";

const addFormats = addFormatsDefault as unknown as (ajv: unknown) => void;

const strict = new Ajv2020({ allErrors: true, strict: false, coerceTypes: false });
addFormats(strict);
const coercing = new Ajv2020({ allErrors: true, strict: false, coerceTypes: true });
addFormats(coercing);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const compiled = new WeakMap<object, { strict?: ValidateFunction; coercing?: ValidateFunction }>();

function compile(schema: unknown, coerce: boolean): ValidateFunction | undefined {
  if (!isObject(schema)) return undefined;
  let holders = compiled.get(schema);
  if (!holders) {
    holders = {};
    compiled.set(schema, holders);
  }
  const slot = coerce ? "coercing" : "strict";
  const existing = holders[slot];
  if (existing) return existing;
  try {
    const validator = (coerce ? coercing : strict).compile(schema);
    holders[slot] = validator;
    return validator;
  } catch {
    return undefined;
  }
}

export interface ValidationOutcome {
  valid: boolean;
  messages: string[];
}

const VALID: ValidationOutcome = { valid: true, messages: [] };

function run(schema: unknown, value: unknown, coerce: boolean): ValidationOutcome {
  const validator = compile(schema, coerce);
  if (!validator) return VALID;
  if (validator(value)) return VALID;
  const messages = (validator.errors ?? []).map((error) => {
    const at = error.instancePath.length > 0 ? error.instancePath : "/";
    return `${at} ${error.message ?? "is invalid"}`;
  });
  return { valid: false, messages };
}

/** The request body schema an operation declares for JSON content, if any. */
export function requestBodySchema(operation: Record<string, unknown>): unknown {
  const body = operation.requestBody;
  if (!isObject(body)) return undefined;
  const content = body.content;
  if (!isObject(content)) return undefined;
  const json = isObject(content["application/json"]) ? content["application/json"] : Object.values(content)[0];
  if (isObject(json)) return json.schema;
  return undefined;
}

/** Validate a request body against the operation's declared schema. Strict: no coercion. */
export function validateBody(operation: Record<string, unknown>, body: unknown): ValidationOutcome {
  return run(requestBodySchema(operation), body, false);
}

/**
 * Validate the parameters the operation declares for one location (`path` or `query`).
 * Coercing: HTTP delivers a parameter as a string, so `"2"` must be judged as the integer
 * `2` the document declares, not rejected as a string.
 */
export function validateParameters(
  parameters: unknown,
  location: "path" | "query",
  values: Record<string, unknown>,
): ValidationOutcome {
  if (!Array.isArray(parameters)) return VALID;
  for (const parameter of parameters) {
    if (!isObject(parameter) || parameter.in !== location || typeof parameter.name !== "string") continue;
    const name = parameter.name;
    const present = Object.prototype.hasOwnProperty.call(values, name);
    if (!present) {
      if (parameter.required === true) return { valid: false, messages: [`/${name} is required`] };
      continue;
    }
    const outcome = run(parameter.schema, values[name], true);
    if (!outcome.valid) return outcome;
  }
  return VALID;
}

/** Validate a response body against the schema the document declares for `status`. */
export function validateAgainst(schema: unknown, value: unknown): ValidationOutcome {
  return run(schema, value, false);
}
