/**
 * Small readers over a derived resource's representation schema, shared by the configuration
 * reconciler, the conformance check and the value engine. Pure; no behaviour of its own.
 */
import type { Resource } from "./types.js";

export type Schema = Record<string, unknown>;

export function isSchema(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The element schema when a representation is an array, else the schema itself. */
export function elementSchemaOf(resource: Pick<Resource, "representationSchema">): Schema | undefined {
  const schema = resource.representationSchema;
  if (!isSchema(schema)) return undefined;
  if (schema.type === "array" && isSchema(schema.items)) return schema.items;
  return schema;
}

/** The declared properties of a resource's records, in document order (empty when undeclared). */
export function propertiesOf(resource: Pick<Resource, "representationSchema">): Record<string, Schema> {
  const element = elementSchemaOf(resource);
  const properties = element && isSchema(element.properties) ? element.properties : {};
  const out: Record<string, Schema> = {};
  for (const [name, schema] of Object.entries(properties)) out[name] = isSchema(schema) ? schema : {};
  return out;
}

/** True when the schema declares its properties (so "no such property" is decidable). */
export function declaresProperties(resource: Pick<Resource, "representationSchema">): boolean {
  const element = elementSchemaOf(resource);
  return element !== undefined && isSchema(element.properties);
}

/** The names the schema marks required. */
export function requiredOf(resource: Pick<Resource, "representationSchema">): string[] {
  const element = elementSchemaOf(resource);
  return element && Array.isArray(element.required) ? element.required.filter((r): r is string => typeof r === "string") : [];
}
