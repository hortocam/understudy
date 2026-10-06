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
import { patternSupported } from "./identity.js";
import { LIMIT_NAMES, PAGING_PARAM_NAMES, classifyPaging } from "./paging.js";
import type { IdSpaceKind } from "./types.js";

const EVIDENCE_RANK: Record<RelationshipEvidence, number> = {
  configured: 4,
  extension: 3,
  convention: 2,
  nesting: 1,
};

/** The naming-convention rules of link inference (config key `inference`, FR-006 rung 3). */
export interface InferenceRules {
  /** Suffixes that propose a link: `Id` makes `eventId` propose Event. */
  idSuffixes: string[];
  /** Property names that denote a different entity per collection; never decided by convention. */
  ambiguousNames: string[];
}

export const DEFAULT_INFERENCE: InferenceRules = {
  idSuffixes: ["Id", "_id"],
  ambiguousNames: ["externalId", "referenceId", "refId", "parentId"],
};

export interface DeriveOptions {
  /** Naming-convention rules; the documented defaults when absent. */
  inference?: InferenceRules;
  /** Relationships supplied explicitly; the `configured` evidence seam (slice 2 wires config to it). */
  configuredRelationships?: RelationshipHint[];
  /** `entities.<X>.idField` pins, keyed by the FINAL (disambiguated) collection name. */
  idFields?: Record<string, string>;
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
  if (PAGING_PARAM_NAMES.has(n) || n === "pagesize" || n === "per_page") return "paging";
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
  return [...merged.values()].map((parameter) => {
    const param: ListParam = {
      name: parameter.name as string,
      in: "query",
      kind: classifyParam(parameter.name as string),
      required: parameter.required === true,
    };
    const schema = isObject(parameter.schema) ? parameter.schema : undefined;
    const enumValues = schema && Array.isArray(schema.enum) ? schema.enum : undefined;
    const itemEnum = schema && isObject(schema.items) && Array.isArray(schema.items.enum) ? schema.items.enum : undefined;
    const values = (enumValues ?? itemEnum)?.filter((v): v is string => typeof v === "string");
    if (values && values.length > 0) param.values = values;
    if (param.kind === "paging" && schema) {
      const cap = typeof schema.maximum === "number" ? schema.maximum : typeof schema.default === "number" ? schema.default : undefined;
      if (cap !== undefined && LIMIT_NAMES.includes(param.name.toLowerCase())) param.pageCap = cap;
    }
    return param;
  });
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
  }

  disambiguateNames(resources, ambiguities);
  applyIdFieldPins(resources, ambiguities, options.idFields ?? {});
  for (const resource of resources) {
    if (resource.instancePath) instancePathToResource.set(resource.instancePath, resource.name);
  }

  const relationships = inferRelationships(document, resources, instancePathToResource, options, ambiguities);
  return { resources, relationships, ambiguities };
}

/** A path-qualified name: every literal segment, PascalCased, the last one singular (`/shops/tags` → `ShopsTag`). */
function qualifiedName(collectionPath: string): string {
  const literal = segments(collectionPath).filter((segment) => !isParamSegment(segment));
  return literal
    .map((segment, index) => capitalise(index === literal.length - 1 ? singularise(segment) : segment))
    .join("")
    .replace(/[^A-Za-z0-9_]/g, "");
}

/**
 * The key SQLite uses for table identity. `sqlite3_stricmp` folds ASCII letters only, so two
 * resource names that differ just by ASCII case (`Foo` / `foo`) address the SAME physical table;
 * a non-ASCII pair (`Café` / `CAFÉ`) stays distinct under SQLite and under this fold.
 */
function foldName(name: string): string {
  return name.replace(/[A-Z]/g, (char) => char.toLowerCase());
}

/**
 * Two distinct collections must never share a name: the store, identity spaces, plan and config
 * are all keyed by it, so a shared name would fuse them silently. An exact duplicate and a
 * case-folded collision (`Foo` / `foo`) are the *same* defect — SQLite compares table identifiers
 * case-insensitively, so both would share one physical table — so both are handled here. Every
 * colliding resource is renamed to a path-qualified, deterministic name (none keeps a name that
 * folds into the collision key, so nothing quietly "wins"), and the collision is reported with the
 * colliding paths and the chosen names (FR-007).
 */
function disambiguateNames(resources: Resource[], ambiguities: Ambiguity[]): void {
  const byFold = new Map<string, Resource[]>();
  for (const resource of resources) {
    const key = foldName(resource.name);
    const list = byFold.get(key) ?? [];
    list.push(resource);
    byFold.set(key, list);
  }
  // `taken` holds FOLDED names, so a newly chosen name can never fold onto an untouched one.
  const taken = new Set<string>(
    [...byFold.entries()].filter(([, group]) => group.length === 1).map(([key]) => key),
  );
  for (const key of [...byFold.keys()].sort()) {
    const group = (byFold.get(key) ?? []).slice().sort((a, b) => a.collectionPath.localeCompare(b.collectionPath));
    if (group.length < 2) continue;
    // Capture the colliding names BEFORE renaming — the report names the originals the document
    // declared, never the names this function chose.
    const originalNames = group.map((resource) => resource.name);
    // The collision's human-facing subject: the shared exact name for an exact duplicate, else the
    // folded key when the colliding names differ only by case.
    const exactDuplicate = originalNames.every((name) => name === originalNames[0]);
    const sharedName = exactDuplicate ? (originalNames[0] as string) : key;
    const renamed: string[] = [];
    for (const resource of group) {
      const base = qualifiedName(resource.collectionPath) || resource.name;
      let candidate = base;
      for (let n = 2; taken.has(foldName(candidate)) || foldName(candidate) === key; n += 1) candidate = `${base}${n}`;
      taken.add(foldName(candidate));
      for (const ambiguity of ambiguities) {
        if (ambiguity.path !== (resource.instancePath ?? resource.collectionPath) && ambiguity.path !== resource.collectionPath) continue;
        if (ambiguity.kind === "duplicate-resource-name") continue;
        if (ambiguity.subject === resource.name) ambiguity.subject = candidate;
        ambiguity.detail = ambiguity.detail.split(resource.name).join(candidate);
      }
      resource.name = candidate;
      renamed.push(`${resource.collectionPath} → ${candidate}`);
    }
    const lead = exactDuplicate
      ? `${group.length} distinct collections would all be named ${sharedName}`
      : `${group.length} distinct collections have names that collide only by case (${originalNames.join(", ")})`;
    ambiguities.push({
      kind: "duplicate-resource-name",
      path: group[0]?.collectionPath ?? "",
      subject: sharedName,
      detail: `${lead} (${group.map((r) => r.collectionPath).join(", ")}); each was given a path-qualified name (${renamed.join("; ")}) — pin a schema title or rename them in the document to choose`,
    });
  }
}

const IDENTITY_AMBIGUITIES: ReadonlySet<string> = new Set([
  "identity-field-unknown",
  "identity-space-unreservable",
  "identity-pattern-unsupported",
]);

/**
 * `entities.<X>.idField` makes a different property the collection's identity (the fixture layer
 * already honours it). The identity facts — type, pattern, space — are re-read from that property
 * and the identity ambiguities are re-reported against it, so live CRUD, generation and the report
 * all agree with the fixtures.
 */
function applyIdFieldPins(resources: Resource[], ambiguities: Ambiguity[], pins: Record<string, string>): void {
  for (const resource of resources) {
    const pin = pins[resource.name];
    if (pin === undefined || pin === resource.idField) continue;
    const key = resource.instancePath ?? resource.collectionPath;
    for (let i = ambiguities.length - 1; i >= 0; i -= 1) {
      const a = ambiguities[i] as Ambiguity;
      if (a.path === key && IDENTITY_AMBIGUITIES.has(a.kind)) ambiguities.splice(i, 1);
    }
    const element = elementSchema(resource.representationSchema);
    const properties = element && isObject(element.properties) ? element.properties : undefined;
    const property = properties && isObject(properties[pin]) ? properties[pin] : undefined;
    resource.idField = pin;
    resource.idType = property?.type === "string" ? "string" : "integer";
    resource.idSpace = idSpaceOf(property, resource.idType);
    delete resource.idPattern;
    if (typeof property?.pattern === "string") resource.idPattern = property.pattern;
    if (resource.idSpace === "opaque") {
      ambiguities.push({
        kind: "identity-space-unreservable",
        path: key,
        subject: resource.name,
        detail: `${resource.name}'s identity is a string with no declared uuid format or pattern, so no range can be reserved within it; identities fall back to opaque short ids and are kept distinct from fixtures by a membership check`,
      });
    }
    if (resource.idPattern !== undefined && resource.idType === "string" && !patternSupported(resource.idPattern)) {
      ambiguities.push({
        kind: "identity-pattern-unsupported",
        path: key,
        ...(resource.operations.read?.operationId !== undefined ? { operationId: resource.operations.read.operationId } : {}),
        detail: `${resource.name} declares identity pattern ${resource.idPattern}, which the mock's generator cannot satisfy; identities fall back to an opaque short id`,
      });
    }
  }
}

/** The identity space an identity property lives in (FR-017): declared type + format + pattern. */
function idSpaceOf(idProperty: Record<string, unknown> | undefined, idType: "integer" | "string"): IdSpaceKind {
  if (idType === "integer") return "integer";
  if (idProperty?.format === "uuid") return "uuid";
  if (typeof idProperty?.pattern === "string") return "formatted";
  return "opaque";
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
  // FR-006: PATCH (merge) and PUT (replace) are *different declared styles*, not two spellings
  // of one update. A document may live both on one instance path, so each keeps its own slot;
  // collapsing them (`PATCH ?? PUT`) left PUT live but unbound and silently swallowed.
  const patchOp = findMethod(instanceOps, "PATCH");
  const putOp = findMethod(instanceOps, "PUT");
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
    ...(patchOp ? { update: operationRef(patchOp) } : {}),
    ...(putOp ? { replace: operationRef(putOp) } : {}),
    ...(deleteOp ? { delete: operationRef(deleteOp) } : {}),
  };

  const idSpace = idSpaceOf(idProperty, idType);
  if (idSpace === "opaque") {
    ambiguities.push({
      kind: "identity-space-unreservable",
      path: instance?.instancePath ?? collectionPath,
      subject: name,
      detail: `${name}'s identity is a string with no declared uuid format or pattern, so no range can be reserved within it; identities fall back to opaque short ids and are kept distinct from fixtures by a membership check`,
    });
  }
  const sortFields = [
    ...new Set(
      listParams
        .filter((param) => param.kind === "sort")
        .flatMap((param) => param.values ?? [])
        .map((value) => value.replace(/^[+-]/, "")),
    ),
  ];

  const resource: Resource = {
    name,
    collectionPath,
    idField,
    idType,
    idSpace,
    pagingStyle: classifyPaging(listParams, Object.keys(properties ?? {})),
    filterFields: listParams.filter((param) => param.kind === "filter").map((param) => param.name),
    sortFields,
    listParams,
    operations,
    nameSource: title ? "schema-title" : "path-segment",
  };
  if (instance) {
    resource.instancePath = instance.instancePath;
    resource.instanceParam = instance.param;
  }
  if (representationSchema !== undefined) resource.representationSchema = representationSchema;
  if (createOp) {
    const createSchema = requestSchema(createOp.operation);
    if (createSchema !== undefined) resource.createSchema = createSchema;
  }
  // data-model.md §1 names a single `updateMode`; with BOTH styles declared on one instance
  // path there is no single style, so it is left unset and both are named in `operations`
  // (`update` = merge, `replace` = replace). The mock decides per operation, not per resource.
  if (patchOp && !putOp) resource.updateMode = "merge";
  else if (putOp && !patchOp) resource.updateMode = "replace";
  if (idPattern !== undefined) {
    resource.idPattern = idPattern;
    // FR-011 / principle VI: a declared pattern the bounded identity generator cannot satisfy
    // must be reported, not answered with a non-conforming value.
    if (idType === "string" && !patternSupported(idPattern)) {
      ambiguities.push({
        kind: "identity-pattern-unsupported",
        path: instance?.instancePath ?? collectionPath,
        ...(readOp?.operationId !== undefined ? { operationId: readOp.operationId } : {}),
        detail: `${name} declares identity pattern ${idPattern}, which the mock's generator cannot satisfy; identities fall back to an opaque short id`,
      });
    }
  }
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

/** Lower-case word tokens of a camelCase / snake_case name: `viagogoEventId` -> viagogo, event, id. */
function tokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_]+/)
    .filter((t) => t.length > 0)
    .map((t) => t.toLowerCase());
}

function endsWith(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  return needle.every((token, i) => haystack[haystack.length - needle.length + i] === token);
}

/** The scalar type a link property declares (an array's element type), if any. */
function linkType(schema: Record<string, unknown>): string | undefined {
  if (schema.type === "array" && isObject(schema.items)) return typeof schema.items.type === "string" ? schema.items.type : undefined;
  return typeof schema.type === "string" ? schema.type : undefined;
}

interface Proposal {
  target: Resource;
  /** The entity's own name tokens matched as the whole name (`eventId`) rather than after a prefix. */
  exact: boolean;
}

/**
 * Which collections a property name PROPOSES (FR-006 rung 3): the name's tokens end with an
 * entity's tokens followed by an id suffix (`viagogoEventId` proposes Event), or are exactly the
 * entity name. The longest entity match wins (`orderLineId` proposes OrderLine, not Line); a tie
 * is returned whole so the caller can see it was not decisive.
 */
function propose(field: string, owner: Resource, resources: Resource[], property: Record<string, unknown>, rules: InferenceRules): Proposal[] {
  const fieldTokens = tokens(field);
  const suffixes = rules.idSuffixes.map((suffix) => tokens(suffix));
  const found: Array<Proposal & { weight: number }> = [];
  for (const candidate of resources) {
    if (candidate.name === owner.name) continue;
    const entity = tokens(candidate.name);
    const bare = fieldTokens.length === entity.length && endsWith(fieldTokens, entity);
    let matched = bare;
    let exact = bare;
    for (const suffix of suffixes) {
      if (!endsWith(fieldTokens, [...entity, ...suffix])) continue;
      matched = true;
      if (fieldTokens.length === entity.length + suffix.length) exact = true;
    }
    if (!matched) continue;
    const type = linkType(property);
    if (type !== undefined && type !== candidate.idType) continue; // an integer link cannot reference a string identity
    found.push({ target: candidate, exact, weight: entity.length });
  }
  const longest = Math.max(0, ...found.map((f) => f.weight));
  return found.filter((f) => f.weight === longest).map(({ target, exact }) => ({ target, exact }));
}

function inferRelationships(
  document: Record<string, unknown>,
  resources: Resource[],
  instancePathToResource: Map<string, string>,
  options: DeriveOptions,
  ambiguities: Ambiguity[],
): Relationship[] {
  const rules = options.inference ?? DEFAULT_INFERENCE;
  const collected: Relationship[] = [];
  const names = new Set(resources.map((resource) => resource.name));
  const ambiguousNames = new Set(rules.ambiguousNames.map((n) => n.toLowerCase()));
  const decided = (r: Omit<Relationship, "status">): Relationship => ({ ...r, status: "decided" });

  // (1) configured
  for (const hint of options.configuredRelationships ?? []) {
    if (!names.has(hint.from) || !names.has(hint.to)) continue;
    collected.push(decided({ from: hint.from, to: hint.to, field: hint.field, cardinality: "one", evidence: "configured" }));
  }

  // (2) spec extension
  for (const hint of asHints(document["x-understudy-relationships"])) {
    if (!names.has(hint.from) || !names.has(hint.to)) continue;
    collected.push(decided({ from: hint.from, to: hint.to, field: hint.field, cardinality: "one", evidence: "extension" }));
  }

  // (3) naming convention — a hit PROPOSES; it decides only when nothing competes with it.
  const undetermined: Relationship[] = [];
  const undeterminedLink = (owner: Resource, field: string, to: string, candidates: string[], detail: string): void => {
    undetermined.push({
      from: owner.name,
      to,
      field,
      cardinality: cardinalityOf(owner, field),
      evidence: "convention",
      status: "undetermined",
      candidates,
    });
    ambiguities.push({ kind: "undetermined-link", subject: `${owner.name}.${field}`, detail });
  };
  for (const resource of resources) {
    const element = elementSchema(resource.representationSchema);
    const properties = element && isObject(element.properties) ? element.properties : undefined;
    if (!properties) continue;
    const bySiblingTarget = new Map<string, Array<{ field: string; target: Resource }>>();
    for (const field of Object.keys(properties)) {
      if (field === resource.idField) continue;
      const property = isObject(properties[field]) ? properties[field] : {};
      if (ambiguousNames.has(field.toLowerCase())) {
        undeterminedLink(
          resource,
          field,
          "",
          [],
          `${resource.name}.${field} is a known-ambiguous name: it denotes a different external entity per collection, so the convention does not decide it; pin it with entities.${resource.name}.relations.${field} if it is a link`,
        );
        continue;
      }
      const proposals = propose(field, resource, resources, property, rules);
      if (proposals.length > 1) {
        const targets = proposals.map((p) => p.target.name).sort();
        ambiguities.push({
          kind: "ambiguous-relationship",
          subject: `${resource.name}.${field}`,
          detail: `property "${field}" on ${resource.name} matches more than one entity: ${targets.join(", ")}`,
        });
        undeterminedLink(
          resource,
          field,
          "",
          targets,
          `${resource.name}.${field} could reference any of ${targets.join(", ")}; pin it with entities.${resource.name}.relations.${field}`,
        );
        continue;
      }
      const only = proposals[0];
      if (only) {
        const list = bySiblingTarget.get(only.target.name) ?? [];
        list.push({ field, target: only.target });
        bySiblingTarget.set(only.target.name, list);
      }
    }
    for (const [targetName, fields] of bySiblingTarget) {
      const target = fields[0]?.target as Resource;
      if (fields.length === 1) {
        const only = fields[0] as { field: string };
        collected.push(
          decided({
            from: resource.name,
            to: targetName,
            field: only.field,
            cardinality: cardinalityOf(resource, only.field),
            evidence: "convention",
          }),
        );
        continue;
      }
      // Two or more sibling properties could each be the link: record the tie, decide nothing.
      const candidates = fields.map((f) => f.field).sort();
      for (const { field } of fields) {
        undeterminedLink(
          resource,
          field,
          target.name,
          candidates,
          `${resource.name} has several properties that could each be the link to ${target.name} (${candidates.join(", ")}); the convention does not choose between them — pin one with entities.${resource.name}.relations`,
        );
      }
    }
  }

  // (4) nesting: a collection nested under another resource's instance path
  for (const resource of resources) {
    const parent = parentPath(resource.collectionPath);
    const parentName = instancePathToResource.get(parent);
    if (parentName && parentName !== resource.name) {
      collected.push(
        decided({
          from: resource.name,
          to: parentName,
          field: `${lowerFirst(parentName)}Id`,
          cardinality: "one",
          evidence: "nesting",
        }),
      );
    }
  }

  // A pin (configured) or a declared extension RESOLVES a tie: the competing undetermined
  // siblings that point at the same target, and an undetermined link on the same field, go away.
  const resolvers = collected.filter((r) => r.evidence === "configured" || r.evidence === "extension");
  const survivors = undetermined.filter(
    (u) => !resolvers.some((r) => r.from === u.from && (r.field === u.field || (u.to !== "" && r.to === u.to))),
  );
  const resolvedSubjects = new Set(undetermined.filter((u) => !survivors.includes(u)).map((u) => `${u.from}.${u.field}`));
  for (let i = ambiguities.length - 1; i >= 0; i -= 1) {
    const a = ambiguities[i] as Ambiguity;
    if (a.kind === "undetermined-link" && a.subject !== undefined && resolvedSubjects.has(a.subject)) ambiguities.splice(i, 1);
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
  return [...byKey.values(), ...survivors];
}
