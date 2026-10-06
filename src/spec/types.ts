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
  /** The parameter's declared enum values, when it has them (a `sort` parameter's sortable fields). */
  values?: string[];
  /** A paging parameter's declared size cap (`maximum`, else `default`) — what one page can hold. */
  pageCap?: number;
}

/** The identity space a collection's reserved range lives in (FR-017, Amendment D). */
export type IdSpaceKind = "integer" | "uuid" | "formatted" | "opaque";

/** How a collection pages (FR-015, Amendment C; the target's form is `cursor-in-schema`). */
export type PagingStyleKind = "cursor-in-schema" | "offset-limit" | "page-size" | "none-declared";

export interface Resource {
  name: string;
  collectionPath: string;
  instancePath?: string;
  /** The path parameter that names an instance in `instancePath` (may differ from `idField`). */
  instanceParam?: string;
  idField: string;
  idType: "integer" | "string";
  idPattern?: string;
  representationSchema?: unknown;
  createSchema?: unknown;
  updateMode?: "merge" | "replace";
  listParams: ListParam[];
  /** The identity space the reserved range lives in. */
  idSpace: IdSpaceKind;
  /** How the collection pages, from its list operation's parameters and response schema. */
  pagingStyle: PagingStyleKind;
  /** Properties the list operation filters on (a filter parameter's name). */
  filterFields: string[];
  /** Properties the list operation can sort by (the enum of a sort parameter, when declared). */
  sortFields: string[];
  operations: ResourceOperations;
  nameSource: "schema-title" | "path-segment";
}

export type RelationshipEvidence = "configured" | "extension" | "convention" | "nesting";

export interface Relationship {
  from: string;
  /** The target collection; empty for an undetermined link that proposes no single target. */
  to: string;
  field: string;
  cardinality: "one" | "many";
  evidence: RelationshipEvidence;
  /**
   * `decided` when exactly one candidate survives the evidence order; `undetermined` when the
   * convention fired but did not decide (FR-006). An undetermined link is reported and NOT acted
   * on: it orders nothing and produces no foreign key.
   */
  status: "decided" | "undetermined";
  /** The competing properties/targets that made it ambiguous (undetermined links only). */
  candidates?: string[];
}

export type AmbiguityKind =
  | "route-without-resource"
  | "no-representation-schema"
  | "no-list-parameters"
  | "identity-field-unknown"
  | "identity-pattern-unsupported"
  | "ambiguous-relationship"
  | "undetermined-link"
  | "identity-space-unreservable"
  | "paging-not-exercised"
  | "unpaged-large-collection"
  | "clock-unpinned"
  | "lookup-only"
  | "import-source"
  | "duplicate-resource-name";

export interface Ambiguity {
  kind: AmbiguityKind;
  path?: string;
  operationId?: string;
  /** A stable key for what this is about (`Order.eventId`, a collection name), for reports and goldens. */
  subject?: string;
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

/** What generation will do, in the report's own terms (structurally satisfied by `data/plan.ts`'s plan). */
export interface PlanSummary {
  order: string[];
  cycles: Array<{ members: string[]; unresolved: string[] }>;
  counts: Record<
    string,
    | { kind: "absolute"; n: number }
    | { kind: "perParent"; parent: string; field: string; range: [number, number]; distribution: string }
    | { kind: "import" }
  >;
}

/** A property indexed because the document declares it filterable/sortable, and the parameter that caused it. */
export interface IndexReason {
  resource: string;
  field: string;
  reason: string;
}

/** A collection's identity space and reserved range, as reported at startup (FR-017). */
export interface IdentityReport {
  resource: string;
  space: IdSpaceKind;
  declared: string;
  reserved: string;
  unreservable: boolean;
}

/** What the generation run did (FR-021): counts by collection and origin, and where each value came from (FR-010). */
export interface GenerationReport {
  recipe: string;
  seed: number;
  /** False when the store already held this recipe+seed+configuration and nothing was generated (D7). */
  regenerated: boolean;
  /** Records this run created, by collection then origin. */
  created: Record<string, Partial<Record<"static" | "imported" | "generated" | "runtime", number>>>;
  /** For each collection and field: how many values each precedence level supplied. */
  provenance: Record<string, Record<string, Record<string, number>>>;
  /** Fields whose values were chosen by a heuristic or a type default (levels 5–6) — the report says so. */
  fallbacks: Array<{ collection: string; field: string; rule: string; level: number; count: number }>;
  redraws: number;
  notes: string[];
}

export interface StartupReport {
  spec: {
    source: string;
    version: string;
    sourceVersion: string;
    contentHash: string;
  };
  clock: { mode: "real"; pinned?: boolean; instant?: string };
  /** The global seed in force (0 when none is configured — there is no hidden entropy). */
  seed?: number;
  /** The selected recipe, when one is. */
  recipe?: string;
  plan?: PlanSummary;
  /** Per-collection identity space and reserved range. */
  identity?: IdentityReport[];
  generation?: GenerationReport;
  indexes: IndexReason[];
  /** Record counts per collection and origin, once the store is populated (FR-004). */
  origins?: Record<string, Partial<Record<"static" | "imported" | "generated" | "runtime", number>>>;
  live: OperationRef[];
  notSelected: OperationRef[];
  /** Which selector form resolved each live operation (FR-023; amendment A2). */
  selection: SelectionReport;
  resources: Resource[];
  relationships: Relationship[];
  ambiguities: Ambiguity[];
}