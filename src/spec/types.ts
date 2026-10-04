/**
 * Shared types for the spec-derived model (data-model.md §1).
 *
 * These are data shapes only — no behaviour — so every module in `spec/` can agree
 * on the model without importing each other's implementation.
 */

export interface DocumentOperation {
  method: string;
  path: string;
  operationId?: string;
  operation: Record<string, unknown>;
}

export interface SelectionResult {
  live: DocumentOperation[];
  notImplemented: DocumentOperation[];
}

export interface OperationRef {
  method: string;
  path: string;
  operationId?: string;
}

export interface ResourceOperations {
  list?: OperationRef;
  create?: OperationRef;
  read?: OperationRef;
  update?: OperationRef;
  delete?: OperationRef;
}

export type ListParamKind = "filter" | "sort" | "paging";

export interface ListParam {
  name: string;
  in: string;
  kind: ListParamKind;
  required: boolean;
}

export interface Resource {
  name: string;
  collectionPath: string;
  instancePath?: string;
  idField: string;
  idType: "integer" | "string";
  idPattern?: string;
  representationSchema?: unknown;
  createSchema?: unknown;
  updateMode?: "merge" | "replace";
  listParams: ListParam[];
  operations: ResourceOperations;
  nameSource: "schema-title" | "path-segment";
}

export type RelationshipEvidence = "configured" | "extension" | "convention" | "nesting";

export interface Relationship {
  from: string;
  to: string;
  field: string;
  cardinality: "one" | "many";
  evidence: RelationshipEvidence;
}

export type AmbiguityKind =
  | "route-without-resource"
  | "no-representation-schema"
  | "identity-field-unknown"
  | "ambiguous-relationship";

export interface Ambiguity {
  kind: AmbiguityKind;
  path?: string;
  operationId?: string;
  detail: string;
}

export interface DerivedModel {
  resources: Resource[];
  relationships: Relationship[];
  ambiguities: Ambiguity[];
}

/** A relationship a caller supplies explicitly (the `configured` evidence seam). */
export interface RelationshipHint {
  from: string;
  to: string;
  field: string;
}

export interface LoadedSpec {
  source: string;
  isUrl: boolean;
  /** The internal dialect version after 3.0 → 3.1 normalisation, e.g. `3.1.1`. */
  version: string;
  /** The version the document declared, e.g. `3.0.3`. */
  sourceVersion: string;
  /** SHA-256 of the raw source text. */
  contentHash: string;
  /** The dereferenced document, normalised to OpenAPI 3.1. */
  document: Record<string, unknown>;
}

export interface StartupReport {
  spec: {
    source: string;
    version: string;
    sourceVersion: string;
    contentHash: string;
  };
  clock: { mode: "real" };
  live: OperationRef[];
  notSelected: OperationRef[];
  resources: Resource[];
  relationships: Relationship[];
  ambiguities: Ambiguity[];
}