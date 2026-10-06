/**
 * Conformance of a record to the document's own schema (FR-014, SC-004).
 *
 * One Ajv validator per resource, compiled once from the dereferenced representation schema —
 * the same dialect and formats the mock's request validation uses — so "the generator produced
 * a conforming value" is judged by the document, never by the generator's own opinion.
 */
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsDefault from "ajv-formats";
import { elementSchemaOf, type Schema } from "./schema-util.js";
import type { Ambiguity, Resource } from "./types.js";

const addFormats = addFormatsDefault as unknown as (ajv: unknown) => void;
const ajv = new Ajv2020({ allErrors: true, strict: false, coerceTypes: false });
addFormats(ajv);

const cache = new WeakMap<object, ValidateFunction | null>();
const failures = new WeakMap<object, string>();

function compile(schema: Schema): ValidateFunction | undefined {
  const hit = cache.get(schema);
  if (hit !== undefined) return hit ?? undefined;
  try {
    const validator = ajv.compile(schema);
    cache.set(schema, validator);
    return validator;
  } catch (error) {
    failures.set(schema, error instanceof Error ? error.message : String(error));
    cache.set(schema, null);
    return undefined;
  }
}

/**
 * Collections whose representation schema Ajv cannot compile. Their records cannot be judged
 * against the document, so SC-004 is not enforced for them — which must be reported, not read as
 * "conforms" (principle VI: inference and its limits are always visible).
 */
export function uncheckableResources(resources: readonly Resource[]): Ambiguity[] {
  const found: Ambiguity[] = [];
  for (const resource of resources) {
    const element = elementSchemaOf(resource);
    if (!element || compile(element)) continue;
    found.push({
      kind: "conformance-unchecked",
      path: resource.collectionPath,
      subject: resource.name,
      detail: `${resource.name}'s schema cannot be compiled (${failures.get(element) ?? "unknown reason"}), so its records cannot be checked against it: generated and fixture rows are NOT verified to conform`,
    });
  }
  return found;
}

/** Human-readable violations of a record against the resource's schema; empty when it conforms. */
export function conformanceErrors(resource: Resource, record: unknown): string[] {
  const element = elementSchemaOf(resource);
  if (!element) return [];
  const validate = compile(element);
  if (!validate) return [];
  if (validate(record)) return [];
  return (validate.errors ?? []).map((e) => `${e.instancePath.length > 0 ? e.instancePath : "/"} ${e.message ?? "is invalid"}`);
}

/** Violations of one value against one property's own schema (used to check `choice` sets). */
export function valueErrors(schema: Schema, value: unknown): string[] {
  const validate = compile(schema);
  if (!validate || validate(value)) return [];
  return (validate.errors ?? []).map((e) => e.message ?? "is invalid");
}
