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

/** The three selector forms are peers (FR-002, amendment A2) — an entry's spelling decides. */
export type SelectorForm = "method-path" | "operationId" | "tag";

/** How one configured selection entry resolved against the document (FR-023, A2). */
export interface ResolvedSelectionEntry {
  /** The raw entry exactly as the user wrote it. */
  entry: string;
  /** Which selector form resolved it. */
  form: SelectorForm;
  /** The resolved `METHOD /path`. */
  methodPath: string;
  operationId?: string;
}

export interface SelectionResult {
  live: DocumentOperation[];
  notImplemented: DocumentOperation[];
  /** One record per configured entry, in selection order. */
  resolved: ResolvedSelectionEntry[];
  /** True when a selection uses both forms; FR-023 requires the report to say which form resolved each live operation. */
  mixed: boolean;
  /** The distinct forms this selection used. */
  forms: SelectorForm[];
}

/** The selector-form summary the startup report carries (FR-023, A2). */
export interface SelectionReport {
  mixed: boolean;
  forms: SelectorForm[];
  resolved: ResolvedSelectionEntry[];
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
  /** The merge-style update (PATCH), when the document declares one (FR-006). */
  update?: OperationRef;
  /** The replace-style update (PUT), when the document declares one (FR-006). */
  replace?: OperationRef;
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
  | "no-list-parameters"
  | "identity-field-unknown"
  | "identity-pattern-unsupported"
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
  /** Which selector form resolved each live operation (FR-023; amendment A2). */
  selection: SelectionReport;
  resources: Resource[];
  relationships: Relationship[];
  ambiguities: Ambiguity[];
}