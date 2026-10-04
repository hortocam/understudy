/**
 * Resource derivation and relationship inference (`plan.md` → "Derivation rules").
 *
 * Slice 1 derives entities so CRUD has a shape and so the startup report can name
 * them; it generates nothing. Every inference is reported, and anything the rules
 * cannot decide confidently becomes an `Ambiguity` rather than a silent guess
 * (principle VI, FR-023).
 */
import type {
  Ambiguity,
  DerivedModel,
  DocumentOperation,
  ListParam,
  ListParamKind,
  OperationRef,
  Relationship,
  RelationshipEvidence,
  RelationshipHint,
  Resource,
} from "./types.js";

const EVIDENCE_RANK: Record<RelationshipEvidence, number> = {
  configured: 4,
  extension: 3,
  convention: 2,
  nesting: 1,
};

export interface DeriveOptions {
  /** Relationships supplied explicitly; the `configured` evidence seam (slice 2 wires config to it). */
  configuredRelationships?: RelationshipHint[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function segments(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

function lastSegment(path: string): string {
  const parts = segments(path);
  return parts[parts.length - 1] ?? "";
}

function parentPath(path: string): string {
  const parts = segments(path);
  parts.pop();
  return `/${parts.join("/")}`;
}

function isParamSegment(segment: string): boolean {
  return /^\{[^}]+\}$/.test(segment);
}

function paramName(segment: string): string {
  return segment.slice(1, -1);
}

function capitalise(value: string): string {
  return value.length === 0 ? value : value.charAt(0).toUpperCase() + value.slice(1);
}

function lowerFirst(value: string): string {
  return value.length === 0 ? value : value.charAt(0).toLowerCase() + value.slice(1);
}

/** Singularise a path segment. Deliberately small and reported, not clever. */
export function singularise(segment: string): string {
  if (/ies$/i.test(segment)) return `${segment.slice(0, -3)}y`;
  if (/(ses|xes|zes|ches|shes)$/i.test(segment)) return segment.slice(0, -2);
  if (/s$/i.test(segment) && !/ss$/i.test(segment)) return segment.slice(0, -1);
  return segment;
}

function entityNameFromPath(path: string): string {
  return capitalise(singularise(lastSegment(path)));
}

/** The element schema when a representation is an array, else the schema itself. */
function elementSchema(schema: unknown): Record<string, unknown> | undefined {
  if (!isObject(schema)) return undefined;
  if (schema.type === "array" && isObject(schema.items)) return schema.items;
  return schema;
}

function schemaTitle(schema: unknown): string | undefined {
  const element = elementSchema(schema);
  if (element && typeof element.title === "string") return element.title;
  if (isObject(schema) && typeof schema.title === "string") return schema.title;
  return undefined;
}

/** The first 2xx response body schema an operation declares, if any. */
function successSchema(operation: Record<string, unknown>): unknown {
  const responses = operation.responses;
  if (!isObject(responses)) return undefined;
  const codes = Object.keys(responses)
    .filter((code) => /^2\d\d$/.test(code))
    .sort();
  for (const code of codes) {
    const response = responses[code];
    if (!isObject(response)) continue;
    const content = response.content;
    if (!isObject(content)) continue;
    const json = isObject(content["application/json"]) ? content["application/json"] : Object.values(content)[0];
    if (isObject(json) && isObject(json.schema)) return json.schema;
  }
  return undefined;
}

/** The request body schema an operation declares, if any. */
function requestSchema(operation: Record<string, unknown>): unknown {
  const body = operation.requestBody;
  if (!isObject(body)) return undefined;
  const content = body.content;
  if (!isObject(content)) return undefined;
  const json = isObject(content["application/json"]) ? content["application/json"] : Object.values(content)[0];
  if (isObject(json) && isObject(json.schema)) return json.schema;
  return undefined;
}

function classifyParam(name: string): ListParamKind {
  const n = name.toLowerCase();
  if (
    ["limit", "offset", "page", "size", "pagesize", "per_page", "per-page", "cursor", "start", "count"].includes(n)
  ) {
    return "paging";
  }
  if (n === "sort" || n.startsWith("sort") || n.includes("order")) return "sort";
  return "filter";
}

/** The query parameters declared by a `parameters` array, keyed by name. */
function queryParamsOf(parameters: unknown): Map<string, Record<string, unknown>> {
  const byName = new Map<string, Record<string, unknown>>();
  if (!Array.isArray(parameters)) return byName;
  for (const parameter of parameters) {
    if (!isObject(parameter)) continue;
    if (parameter.in !== "query" || typeof parameter.name !== "string") continue;
    byName.set(parameter.name, parameter);
  }
  return byName;
}

/**
 * The list parameters an operation declares.
 *
 * Per OpenAPI "Fixed Fields", a Path Item Object's `parameters` are inherited by every
 * operation on the path, and an operation-level parameter overrides a path-level one with
 * the same name. Reading only `operation.parameters` would miss shared paging/sort
 * declarations and make the report claim a collection is unpaged when it is not (FR-007).
 */
function listParamsOf(
  operation: Record<string, unknown> | undefined,
  pathParameters?: unknown,
): ListParam[] {
  const merged = queryParamsOf(pathParameters);
  for (const [name, parameter] of queryParamsOf(operation?.parameters)) merged.set(name, parameter);
  return [...merged.values()].map((parameter) => ({
    name: parameter.name as string,
    in: "query",
    kind: classifyParam(parameter.name as string),
    required: parameter.required === true,
  }));
}

function operationRef(operation: DocumentOperation): OperationRef {
  const ref: OperationRef = { method: operation.method, path: operation.path };
  if (operation.operationId !== undefined) ref.operationId = operation.operationId;
  return ref;
}

function findMethod(ops: DocumentOperation[], method: string): DocumentOperation | undefined {
  return ops.find((op) => op.method === method);
}

export function deriveModel(
  document: Record<string, unknown>,
  live: DocumentOperation[],
  options: DeriveOptions = {},
): DerivedModel {
  const paths = isObject(document.paths) ? Object.keys(document.paths) : [];
  const liveByPath = new Map<string, DocumentOperation[]>();
  for (const op of live) {
    const list = liveByPath.get(op.path) ?? [];
    list.push(op);
    liveByPath.set(op.path, list);
  }

  // Path Item Object `parameters` are inherited by every operation on the path.
  const pathItemParameters = new Map<string, unknown>();
  if (isObject(document.paths)) {
    for (const [path, pathItem] of Object.entries(document.paths)) {
      if (isObject(pathItem)) pathItemParameters.set(path, pathItem.parameters);
    }
  }

  const collectionPaths = new Set<string>();
  const instancePaths: string[] = [];
  for (const path of paths) {
    if (isParamSegment(lastSegment(path))) instancePaths.push(path);
    else collectionPaths.add(path);
  }

  const ambiguities: Ambiguity[] = [];
  const instanceOf = new Map<string, { instancePath: string; param: string }>();
  for (const instancePath of instancePaths) {
    const parent = parentPath(instancePath);
    const isDirectChild = segments(instancePath).length === segments(parent).length + 1;
    if (collectionPaths.has(parent) && isDirectChild) {
      instanceOf.set(parent, { instancePath, param: paramName(lastSegment(instancePath)) });
    } else {
      const op = liveByPath.get(instancePath)?.[0];
      ambiguities.push({
        kind: "route-without-resource",
        path: instancePath,
        ...(op?.operationId !== undefined ? { operationId: op.operationId } : {}),
        detail: `path ${instancePath} does not extend a collection path by exactly one parameter`,
      });
    }
  }

  const resources: Resource[] = [];
  const instancePathToResource = new Map<string, string>();
  for (const collectionPath of collectionPaths) {
    const collectionOps = liveByPath.get(collectionPath) ?? [];
    const instance = instanceOf.get(collectionPath);
    const instanceOps = instance ? liveByPath.get(instance.instancePath) ?? [] : [];
    if (collectionOps.length === 0 && instanceOps.length === 0) continue;

    const resource = deriveResource(
      collectionPath,
      collectionOps,
      instanceOps,
      instance,
      ambiguities,
      pathItemParameters.get(collectionPath),
    );
    resources.push(resource);
    if (instance) instancePathToResource.set(instance.instancePath, resource.name);
  }

  const relationships = inferRelationships(document, resources, instancePathToResource, options, ambiguities);
  return { resources, relationships, ambiguities };
}

function deriveResource(
  collectionPath: string,
  collectionOps: DocumentOperation[],
  instanceOps: DocumentOperation[],
  instance: { instancePath: string; param: string } | undefined,
  ambiguities: Ambiguity[],
  pathParameters?: unknown,
): Resource {
  const listOp = findMethod(collectionOps, "GET");
  const createOp = findMethod(collectionOps, "POST");
  const readOp = findMethod(instanceOps, "GET");
  const updateOp = findMethod(instanceOps, "PATCH") ?? findMethod(instanceOps, "PUT");
  const deleteOp = findMethod(instanceOps, "DELETE");

  const representationSchema =
    (listOp && successSchema(listOp.operation)) ??
    (createOp && successSchema(createOp.operation)) ??
    (readOp && successSchema(readOp.operation)) ??
    undefined;

  const title = schemaTitle(representationSchema);
  const name = title ?? entityNameFromPath(collectionPath);

  const element = elementSchema(representationSchema);
  const properties = element && isObject(element.properties) ? element.properties : undefined;

  const idField = instance?.param ?? "id";
  const idProperty = properties && isObject(properties[idField]) ? properties[idField] : undefined;
  const idType = idProperty?.type === "string" ? "string" : "integer";
  const idPattern = typeof idProperty?.pattern === "string" ? idProperty.pattern : undefined;

  const listParams = listParamsOf(listOp?.operation, pathParameters);

  if (representationSchema === undefined) {
    const op = listOp ?? createOp ?? readOp;
    ambiguities.push({
      kind: "no-representation-schema",
      path: collectionPath,
      ...(op?.operationId !== undefined ? { operationId: op.operationId } : {}),
      detail: `no 2xx response schema is declared for ${name}; its representation cannot be derived`,
    });
  } else if (instance && properties && !isObject(properties[idField]) && !isObject(properties.id)) {
    ambiguities.push({
      kind: "identity-field-unknown",
      path: instance.instancePath,
      detail: `the identity parameter "${instance.param}" is not declared on ${name} and there is no "id" property`,
    });
  }

  // FR-007 / plan.md "Derivation rules" → List semantics: a list operation that declares
  // no query parameters returns the full collection, and the report must say so rather than
  // let the caller assume filtering/paging exists.
  if (listOp && listParams.length === 0) {
    ambiguities.push({
      kind: "no-list-parameters",
      path: collectionPath,
      ...(listOp.operationId !== undefined ? { operationId: listOp.operationId } : {}),
      detail: `${name} declares no list parameters; every list request returns the full collection unpaged and unsorted`,
    });
  }

  const operations = {
    ...(listOp ? { list: operationRef(listOp) } : {}),
    ...(createOp ? { create: operationRef(createOp) } : {}),
    ...(readOp ? { read: operationRef(readOp) } : {}),
    ...(updateOp ? { update: operationRef(updateOp) } : {}),
    ...(deleteOp ? { delete: operationRef(deleteOp) } : {}),
  };

  const resource: Resource = {
    name,
    collectionPath,
    idField,
    idType,
    listParams,
    operations,
    nameSource: title ? "schema-title" : "path-segment",
  };
  if (instance) resource.instancePath = instance.instancePath;
  if (representationSchema !== undefined) resource.representationSchema = representationSchema;
  if (createOp) {
    const createSchema = requestSchema(createOp.operation);
    if (createSchema !== undefined) resource.createSchema = createSchema;
  }
  if (updateOp) resource.updateMode = updateOp.method === "PATCH" ? "merge" : "replace";
  if (idPattern !== undefined) resource.idPattern = idPattern;
  return resource;
}

function asHints(value: unknown): RelationshipHint[] {
  if (!Array.isArray(value)) return [];
  const hints: RelationshipHint[] = [];
  for (const entry of value) {
    if (!isObject(entry)) continue;
    if (typeof entry.from !== "string" || typeof entry.to !== "string" || typeof entry.field !== "string") continue;
    hints.push({ from: entry.from, to: entry.to, field: entry.field });
  }
  return hints;
}

function cardinalityOf(resource: Resource, field: string): "one" | "many" {
  const element = elementSchema(resource.representationSchema);
  const properties = element && isObject(element.properties) ? element.properties : undefined;
  const property = properties && isObject(properties[field]) ? properties[field] : undefined;
  return property?.type === "array" ? "many" : "one";
}

function inferRelationships(
  document: Record<string, unknown>,
  resources: Resource[],
  instancePathToResource: Map<string, string>,
  options: DeriveOptions,
  ambiguities: Ambiguity[],
): Relationship[] {
  const collected: Relationship[] = [];
  const names = new Set(resources.map((resource) => resource.name));

  // (1) configured
  for (const hint of options.configuredRelationships ?? []) {
    if (!names.has(hint.from) || !names.has(hint.to)) continue;
    collected.push({ from: hint.from, to: hint.to, field: hint.field, cardinality: "one", evidence: "configured" });
  }

  // (2) spec extension
  for (const hint of asHints(document["x-understudy-relationships"])) {
    if (!names.has(hint.from) || !names.has(hint.to)) continue;
    collected.push({ from: hint.from, to: hint.to, field: hint.field, cardinality: "one", evidence: "extension" });
  }

  // (3) naming convention
  for (const resource of resources) {
    const element = elementSchema(resource.representationSchema);
    const properties = element && isObject(element.properties) ? element.properties : undefined;
    if (!properties) continue;
    for (const field of Object.keys(properties)) {
      const lower = field.toLowerCase();
      const matches = resources.filter((candidate) => {
        if (candidate.name === resource.name) return false;
        const base = lowerFirst(candidate.name).toLowerCase();
        return lower === `${base}id` || lower === `${base}_id` || lower === base;
      });
      if (matches.length > 1) {
        ambiguities.push({
          kind: "ambiguous-relationship",
          detail: `property "${field}" on ${resource.name} matches more than one entity: ${matches
            .map((match) => match.name)
            .join(", ")}`,
        });
        continue;
      }
      const target = matches[0];
      if (target) {
        collected.push({
          from: resource.name,
          to: target.name,
          field,
          cardinality: cardinalityOf(resource, field),
          evidence: "convention",
        });
      }
    }
  }

  // (4) nesting: a collection nested under another resource's instance path
  for (const resource of resources) {
    const parent = parentPath(resource.collectionPath);
    const parentName = instancePathToResource.get(parent);
    if (parentName && parentName !== resource.name) {
      collected.push({
        from: resource.name,
        to: parentName,
        field: `${lowerFirst(parentName)}Id`,
        cardinality: "one",
        evidence: "nesting",
      });
    }
  }

  // Deduplicate by (from, to, field), keeping the strongest evidence.
  const byKey = new Map<string, Relationship>();
  for (const relationship of collected) {
    const key = `${relationship.from}\u0000${relationship.to}\u0000${relationship.field}`;
    const existing = byKey.get(key);
    if (!existing || EVIDENCE_RANK[relationship.evidence] > EVIDENCE_RANK[existing.evidence]) {
      byKey.set(key, relationship);
    }
  }
  return [...byKey.values()];
}